# Socket MCP Server

A Model Context Protocol (MCP) server for Socket integration, allowing AI assistants to efficiently check dependency vulnerability scores and security information.

🛠️ This project is in early development and rapidly evolving.

## Tools

### depscore

The `depscore` tool allows AI assistants to query the Socket API for dependency scoring information. It provides security and quality metrics for packages across different ecosystems.

**Parameters:**

- `ecosystem`: The package ecosystem (e.g., npm, PyPI). Defaults to "npm".
- `depname`: The name of the dependency.
- `version`: The version of the dependency. Defaults to "unknown".

## Configuration

### Getting an API key

To use the Socket MCP Server, you need to create an API key. You can do this by following [these steps](https://docs.socket.dev/reference/creating-and-managing-api-tokens). The only required permission scope is `packages:list`, which allows the MCP server to query package metadata for dependency scores.


### Usage with Claude Desktop

> [!NOTE]
> Custom integrations are not available to all paid versions of Claude. Check [here](https://support.anthropic.com/en/articles/11175166-about-custom-integrations-using-remote-mcp) for more information.

To use this MCP server with Claude Desktop:

1. Install the Socket MCP server:

   ```bash
   npm install -g @socketsecurity/mcp
   ```

2. Set the API key in your environment:

   ```bash
   export SOCKET_API_KEY=your_api_key_here
   ```

3. In Claude Desktop, go to Settings > Developer > Edit Config.


```js
{
  "mcpServers": {
    "socket-mcp": {
        "command": "socket-mcp",
        "args": [],
      "env": {
        "SOCKET_API_KEY": "your-api-key"
      }
    }
  }
}
```

4. Enter the following:
   - Name: Socket
   - Command: `socket-mcp`
   - Save the configuration.

5. Now you can ask Claude questions like "Check the security score for express version 4.18.2".

The process is similar for Claude Code. See the [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code/tutorials#set-up-model-context-protocol-mcp) for more details.

### Usage with VS Code

For quick installation, you can use the following link to install the Socket MCP server in VS Code:


[![Install in VS Code](https://img.shields.io/badge/VS_Code-Socket_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=socket-mcp&inputs=[{"type":"promptString","id":"socket_api_key","description":"Socket%20API%20key","password":true}]&config={"command":"depscore","type":"stdio","env":{"SOCKET_API_KEY":"${input:socket_api_key}"}})


To use this MCP server in VS Code:

1. Set the API key in your environment:

   ```bash
   export SOCKET_API_KEY=your_api_key_here
   ```

2. In VS Code settings, add the Socket MCP server to your configuration `.vscode/mcp.json` file:

   ```json
    {
        "inputs": [
            {
                "type": "promptString",
                "id": "socket_api_key",
                "description": "Socket API Key",
                "password": true
            }
        ],
        "servers": {
            "socket-mcp": {
                "type": "stdio",
                "command": "socket-mcp",
                "args": [],
                    "env": {
                        "SOCKET_API_KEY": "${input:socket_api_key}"
                    },
            }
        }
    }
   ```

3. Now you can ask questions about dependency security within your VS Code environment.
4. Feel free to add the following to your `.github/copilot-instructions.md` file to control better how the tools is used by your agent:

   ```markdown
   ## Socket MCP Server
    Always check the dependencies scores with the depscore tool when you add a new dependency. If the score is low, consider using an alternative library or writing the code yourself. If you decide to use a library with a low score, make sure to document the reasons for your choice. If you are unsure about the score, ask for a review from someone with more experience.

    When checking dependencies, make sure to also check the imports not just the pyproject.toml/package.json/dependency file.
   ```

## Development

### Prerequisites

- Node.js v16 or higher
- npm or yarn

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/SocketDev/socket-mcp.git
cd socket-mcp
npm install
```

## Build

To build the project:

```bash
npm run build
```

This compiles the TypeScript files and makes the binary executable called `socket-mcp`.

## Run

To run the Socket MCP server locally:

```bash
export SOCKET_API_KEY=your_api_key_here
node build/index.js
```

After installing globally, you can run the executable directly:

```bash
export SOCKET_API_KEY=your_api_key_here
socket-mcp
```

### Global Installation

To install the tool globally and make the `socket-mcp` command available system-wide:

```bash
npm install -g .
```

After global installation, you can use the `socket-mcp` command from anywhere:

```bash
export SOCKET_API_KEY=your_api_key_here
socket-mcp
```

## Adjust tool usage with custom rules

You can further customize how the Socket MCP server interacts with your AI assistant by modifying your client rules. The rules are usually a markdown file and its location depends on the AI assistant you are using.

| MCP Client | Rules File Location |
|---|---|
| Claude Desktop/Code | `CLAUDE.md`  |
| VSCode Copilot | `.github/copilot-instructions.md`  |
| Cursor | `.cursor/rules` |


Rules that can be added to the client rules file include the following:

```md
Always check dependency scores with the debscore tool when you add a new dependency. If the score is low, consider using an alternative library or writing the code yourself. If you are unsure about the score, ask for a review from someone with more experience. When checking dependencies, make sure to also check the imports not just the pyproject.toml file.
```

You can adjust the rules to fit your needs. For example, you can add rules to include specific manifest files, or guide the AI assistant on how to handle low scores. The rules are flexible and can be tailored to your workflow.
