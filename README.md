# goal-seek-ai
VS Code extension that uses AI to seek code changes until your goal is reached - like Excel's Goal Seek but for code! It iteratively modifies code and runs your specified command until success.

## Disclaimer

⚠️ This extension was primarily written by Claude (claude.ai) in a rapid prototyping session. The code is functional but may require refinement. Active maintenance will depend on community interest - if you find this useful and would like to see it developed further, please open an issue or star the repo!

## Features

- Automatically iterates through code modifications until command succeeds
- Powered by GPT for intelligent code fixes
- Maintains history of attempts
- Configurable success/failure patterns
- Supports any shell command for validation
- Pause/Resume capability

## Installation

Install from VSIX:
```bash
code --install-extension goal-seek-ai-1.0.0.vsix
```

## Usage

1. Open command palette (Cmd + Shift + P)
2. Type "Goal Seek AI: Start"
3. Enter your desired code changes
4. Provide the shell command to validate success (e.g., `npm test`, `python -m pytest`)

## Local Development

### Prerequisites
- Node.js (LTS version recommended)
- Yarn
- VS Code

### Setup
```bash
# Clone repository
git clone https://github.com/AlexanderCollins/goal-seek-ai.git
cd goal-seek-ai

# Install dependencies
yarn

# Compile
yarn compile
```

### Running Locally
1. Open in VS Code:
```bash
code .
```
2. Press F5 to start debugging
   - This opens a new VS Code window with the extension loaded
   - You can also use Run > Start Debugging from the menu

### Building Extension Package
```bash
yarn package
```
Creates `goal-seek-ai-1.0.0.vsix`

### Configuration

Set your OpenAI API key in either:
- VS Code settings (goalSeekAI.apiKey)
- Environment variable (OPENAI_API_KEY)

Additional settings available in VS Code:
- Maximum iterations
- Success/failure patterns
- Model temperature
- And more

## License

MIT

## Author

Alexander Collins (@AlexanderCollins)