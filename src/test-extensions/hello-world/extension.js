/**
 * Hello World — Minimal VS Code-compatible extension for CoreCode Spike 3.
 *
 * Tests:
 * 1. Extension lifecycle (activate/deactivate)
 * 2. Command registration via vscode.commands.registerCommand
 * 3. Return values from commands (string, object, computed)
 * 4. Using vscode.window.showInformationMessage
 * 5. Using vscode.workspace.getConfiguration
 */

const vscode = require('vscode');

/**
 * Called when the extension is activated.
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
  console.log('[HelloWorld] Extension activating...');

  // Command 1: Simple hello world
  const helloCmd = vscode.commands.registerCommand('corecode.helloWorld', () => {
    vscode.window.showInformationMessage('Hello from CoreCode extension!');
    return 'Hello, World!';
  });

  // Command 2: Greet with argument
  const greetCmd = vscode.commands.registerCommand('corecode.greet', (name) => {
    const greeting = `Hello, ${name || 'stranger'}! Welcome to CoreCode.`;
    vscode.window.showInformationMessage(greeting);
    return greeting;
  });

  // Command 3: Compute and return (proves data flows back)
  const addCmd = vscode.commands.registerCommand('corecode.add', (a, b) => {
    const result = (a ?? 0) + (b ?? 0);
    return { operation: 'add', a, b, result };
  });

  context.subscriptions.push(helloCmd, greetCmd, addCmd);

  // Read a config value (tests workspace.getConfiguration)
  const config = vscode.workspace.getConfiguration('corecode');
  const greeting = config.get('defaultGreeting', 'Welcome');
  console.log(`[HelloWorld] Config defaultGreeting = "${greeting}"`);

  console.log('[HelloWorld] Extension activated successfully');
}

/**
 * Called when the extension is deactivated.
 */
function deactivate() {
  console.log('[HelloWorld] Extension deactivated');
}

module.exports = { activate, deactivate };
