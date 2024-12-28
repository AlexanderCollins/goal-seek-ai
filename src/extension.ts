import * as vscode from "vscode";
import { spawn } from "child_process";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";

// Configuration interfaces
interface CodeSeekConfig {
  maxIterations: number;
  temperature: number;
  model: string;
  successPatterns: string[];
  errorPatterns: string[];
  checkExitCode: boolean;
  saveHistory: boolean;
  historyPath: string;
}

interface SeekState {
  iterationCount: number;
  originalCode: string;
  attempts: Array<{
    code: string;
    output: string;
    timestamp: number;
    success: boolean;
  }>;
  lastSuccessful?: {
    code: string;
    output: string;
    timestamp: number;
  };
}

interface GPTResponse {
  choices: {
    message: {
      content: string;
    };
  }[];
}

// Default configuration
const DEFAULT_CONFIG: CodeSeekConfig = {
  maxIterations: 10,
  temperature: 0.2,
  model: "gpt-3.5-turbo",
  successPatterns: [],
  errorPatterns: [
    "error",
    "Error",
    "exception",
    "Exception",
    "failed",
    "Failed",
  ],
  checkExitCode: true,
  saveHistory: true,
  historyPath: ".code-seek-history",
};

export function activate(context: vscode.ExtensionContext) {
  // Initialize configuration
  let config = loadConfiguration();
  let currentState: SeekState | null = null;

  // Register configuration change handler
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codeSeekAI")) {
        config = loadConfiguration();
      }
    })
  );

  // Register main command
  const disposable = vscode.commands.registerCommand(
    "extension.codeSeekAI",
    async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          throw new Error(
            "No active editor. Please open a file and try again."
          );
        }

        // Initialize or resume state
        if (!currentState) {
          currentState = initializeState(editor.document.getText());
        }

        // Get user instructions and command
        const userPrompt = await getUserPrompt();
        const commandToRun = await getShellCommand();
        if (!userPrompt || !commandToRun) return;

        // Create status bar item for progress
        const statusBar = createStatusBar();

        // Start the seeking process
        await startSeeking(editor, currentState, {
          userPrompt,
          commandToRun,
          config,
          statusBar,
        });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Code Seek AI error: ${err.message}`);
      }
    }
  );

  // Register pause/resume commands
  context.subscriptions.push(
    vscode.commands.registerCommand("extension.pauseCodeSeek", () => {
      if (currentState) {
        saveState(currentState);
        vscode.window.showInformationMessage("Code Seek AI: Progress saved");
      }
    }),

    vscode.commands.registerCommand("extension.resumeCodeSeek", async () => {
      currentState = await loadState();
      if (currentState) {
        vscode.window.showInformationMessage(
          "Code Seek AI: Resumed from last session"
        );
      }
    }),

    vscode.commands.registerCommand("extension.resetCodeSeek", () => {
      currentState = null;
      vscode.window.showInformationMessage(
        "Code Seek AI: Reset to initial state"
      );
    })
  );

  context.subscriptions.push(disposable);
}

async function startSeeking(
  editor: vscode.TextEditor,
  state: SeekState,
  params: {
    userPrompt: string;
    commandToRun: string;
    config: CodeSeekConfig;
    statusBar: vscode.StatusBarItem;
  }
) {
  const { userPrompt, commandToRun, config, statusBar } = params;
  let isSuccess = false;

  while (!isSuccess && state.iterationCount < config.maxIterations) {
    state.iterationCount++;
    updateStatusBar(statusBar, state.iterationCount, config.maxIterations);

    // Get GPT suggestions
    const newContent = await getGPTSuggestions(state, userPrompt);
    await replaceEditorContent(editor, newContent);

    // Run command and check output
    const { output, exitCode } = await runShellCommand(commandToRun);
    const success = checkSuccess(output, exitCode, config);

    // Record attempt
    state.attempts.push({
      code: newContent,
      output,
      timestamp: Date.now(),
      success,
    });

    if (success) {
      state.lastSuccessful = {
        code: newContent,
        output,
        timestamp: Date.now(),
      };
      isSuccess = true;
      vscode.window.showInformationMessage(
        `Success on iteration ${state.iterationCount}!`
      );
    } else {
      // Prepare context for next attempt
      const fixPrompt = generateFixPrompt(userPrompt, output, state);
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Prevent rate limiting

      // Save progress
      if (config.saveHistory) {
        saveState(state);
      }
    }
  }

  if (!isSuccess) {
    handleFailure(state);
  }

  statusBar.dispose();
}

function generateFixPrompt(
  userPrompt: string,
  output: string,
  state: SeekState
): string {
  return `
Previous instruction: ${userPrompt}

Error output:
${output}

Context:
- This is attempt ${state.iterationCount}
- ${state.attempts.length} previous attempts made
${state.attempts.length > 0 ? "\nPrevious errors encountered:" : ""}
${state.attempts
  .slice(-3)
  .map((a) => `- ${a.output.split("\n")[0]}`)
  .join("\n")}

Please fix the code based on these errors and previous attempts.
Focus on addressing the specific error patterns shown above.
`;
}

async function getGPTSuggestions(
  state: SeekState,
  prompt: string
): Promise<string> {
  const openaiApiKey = getApiKey();
  const config = loadConfiguration();

  const messages = [
    {
      role: "system",
      content:
        "You are an AI coding assistant specializing in fixing code based on error messages and build outputs.",
    },
    {
      role: "user",
      content: `Original Code:\n\`\`\`\n${state.originalCode}\n\`\`\`\n\nUser Instructions:\n${prompt}`,
    },
  ];

  if (state.attempts.length > 0) {
    messages.push({
      role: "assistant",
      content: `Previous attempt analysis:\n${analyzeAttempts(state.attempts)}`,
    });
  }

  const response = await axios.post<GPTResponse>(
    "https://api.openai.com/v1/chat/completions",
    {
      model: config.model,
      messages,
      temperature: config.temperature,
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
    }
  );

  return extractCodeFromResponse(response.data.choices[0].message.content);
}

function analyzeAttempts(attempts: SeekState["attempts"]): string {
  // Analyze patterns in previous attempts to guide future fixes
  const patterns = attempts
    .map((a) => a.output)
    .map(extractErrorPatterns)
    .filter(Boolean);

  return `
Common error patterns identified:
${patterns.slice(-3).join("\n")}

Success rate: ${(
    (attempts.filter((a) => a.success).length / attempts.length) *
    100
  ).toFixed(1)}%
`;
}

function extractErrorPatterns(output: string): string {
  // Extract meaningful error patterns from output
  const errorLines = output
    .split("\n")
    .filter((line) => /error|failed|exception/i.test(line))
    .slice(0, 2);
  return errorLines.join("\n");
}

function checkSuccess(
  output: string,
  exitCode: number | null,
  config: CodeSeekConfig
): boolean {
  if (config.checkExitCode && exitCode !== 0) {
    return false;
  }

  // Check for error patterns
  const hasErrors = config.errorPatterns.some((pattern) =>
    new RegExp(pattern, "i").test(output)
  );
  if (hasErrors) return false;

  // Check for success patterns if specified
  if (config.successPatterns.length > 0) {
    return config.successPatterns.some((pattern) =>
      new RegExp(pattern, "i").test(output)
    );
  }

  return true;
}

async function runShellCommand(
  command: string
): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd: vscode.workspace.rootPath || process.cwd(),
    });

    let stdoutData = "";
    let stderrData = "";

    child.stdout.on("data", (data) => {
      stdoutData += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderrData += data.toString();
    });

    child.on("close", (code) => {
      resolve({
        output: [stdoutData, stderrData].join("\n"),
        exitCode: code,
      });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

// Helper functions for UI/UX
function createStatusBar(): vscode.StatusBarItem {
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left
  );
  statusBar.show();
  return statusBar;
}

function updateStatusBar(
  statusBar: vscode.StatusBarItem,
  current: number,
  max: number
) {
  statusBar.text = `$(sync~spin) Code Seek AI: Iteration ${current}/${max}`;
}

// State management functions
function initializeState(originalCode: string): SeekState {
  return {
    iterationCount: 0,
    originalCode,
    attempts: [],
  };
}

async function saveState(state: SeekState) {
  const config = loadConfiguration();
  if (!config.saveHistory) return;

  const historyDir = path.join(
    vscode.workspace.rootPath || "",
    config.historyPath
  );

  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }

  const filename = `seek-state-${Date.now()}.json`;
  fs.writeFileSync(
    path.join(historyDir, filename),
    JSON.stringify(state, null, 2)
  );
}

async function loadState(): Promise<SeekState | null> {
  const config = loadConfiguration();
  const historyDir = path.join(
    vscode.workspace.rootPath || "",
    config.historyPath
  );

  if (!fs.existsSync(historyDir)) return null;

  const files = fs
    .readdirSync(historyDir)
    .filter((f) => f.startsWith("seek-state-"))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  const latestState = fs.readFileSync(path.join(historyDir, files[0]), "utf8");
  return JSON.parse(latestState);
}

// Configuration helpers
function loadConfiguration(): CodeSeekConfig {
  const config = vscode.workspace.getConfiguration("codeSeekAI");
  return {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(
      Object.entries(DEFAULT_CONFIG).map(([key, defaultValue]) => [
        key,
        config.get(key, defaultValue),
      ])
    ),
  };
}

function getApiKey(): string {
  const key =
    process.env.OPENAI_API_KEY ||
    vscode.workspace.getConfiguration("codeSeekAI").get("apiKey");

  if (!key) {
    throw new Error(
      "OpenAI API key not found. Please set it in settings or environment."
    );
  }

  return key;
}

// Utility functions
async function getUserPrompt(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: "What changes would you like to make to this code?",
    placeHolder: "Describe the desired changes...",
  });
}

async function getShellCommand(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: "Enter the shell command to run for validation",
    placeHolder: "e.g., npm test, python -m pytest, etc.",
  });
}

function handleFailure(state: SeekState) {
  const message = state.lastSuccessful
    ? "Maximum iterations reached, but a previous successful state exists."
    : "Maximum iterations reached without success.";

  vscode.window
    .showWarningMessage(message, "View History", "Restore Last Success")
    .then((selection) => {
      if (selection === "View History") {
        // Show history in new document
        showHistory(state);
      } else if (selection === "Restore Last Success" && state.lastSuccessful) {
        // Restore last successful state
        restoreLastSuccess(state);
      }
    });
}

async function showHistory(state: SeekState) {
  const doc = await vscode.workspace.openTextDocument({
    content: JSON.stringify(state.attempts, null, 2),
    language: "json",
  });
  await vscode.window.showTextDocument(doc);
}

async function restoreLastSuccess(state: SeekState) {
  if (!state.lastSuccessful) return;

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    await replaceEditorContent(editor, state.lastSuccessful.code);
  }
}

async function replaceEditorContent(
  editor: vscode.TextEditor,
  newContent: string
) {
  const document = editor.document;
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
  await editor.edit((editBuilder) => {
    editBuilder.replace(fullRange, newContent);
  });
}

function extractCodeFromResponse(response: string): string {
  // Extract code blocks from GPT response
  const codeBlockRegex = /```(?:\w+)?\n([\s\S]*?)```/;
  const match = response.match(codeBlockRegex);
  return match ? match[1].trim() : response.trim();
}

export function deactivate() {}
