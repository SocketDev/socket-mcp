# Socket MCP Server

A Model Context Protocol (MCP) server for Socket integration, allowing AI assistants to efficiently check dependency vulnerability scores and security information.

## Tools

### depscore

The `depscore` tool allows AI assistants to query the Socket API for dependency scoring information. It provides security and quality metrics for packages across different ecosystems.

**Parameters:**

- `ecosystem`: The package ecosystem (e.g., npm, PyPI). Defaults to "npm".
- `depname`: The name of the dependency.
- `version`: The version of the dependency. Defaults to "unknown".

**Example usage:**

```text
depscore("npm", "express", "4.18.2")
```

## Configuration

### Getting an API key

To use the Socket MCP Server, you need to create an API key. You can do this by following [these steps](https://docs.socket.dev/reference/creating-and-managing-api-tokens).


### Usage with Claude Desktop

To use this MCP server with Claude Desktop:

1. Install the Socket MCP server:

   ```bash
   npm install -g socket-mcp
   ```

2. Set the API key in your environment:

   ```bash
   export SOCKET_API_KEY=your_api_key_here
   ```

3. In Claude Desktop, go to Settings > Assistants > Add Custom Tool.

4. Enter the following:
   - Name: Socket
   - Command: `depscore`
   - Save the configuration.

5. Now you can ask Claude questions like "Check the security score for express version 4.18.2".

### Usage with VS Code

For quick installation, you can use the following link to install the Socket MCP server in VS Code:


[![Install in VS Code](https://img.shields.io/badge/VS_Code-Socket_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22socket-mcp%22%2C%22inputs%22%3A%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22socket_api_key%22%2C%22description%22%3A%22Socket%20API%20Key%22%2C%22password%22%3Atrue%7D%5D%2C%22command%22%3A%22depscore%22%2C%22type%22%3A%22stdio%22%2C%22env%22%3A%7B%22SOCKET_API_KEY%22%3A%22%24%7Binput%3Asocket_api_key%7D%22%7D%7D)


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
                "command": "depscore",
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

This compiles the TypeScript files and makes the binary executable called `depscore`.

## Run

To run the Socket MCP server locally:

```bash
export SOCKET_API_KEY=your_api_key_here
node build/index.js
```

After installing globally, you can run the executable directly:

```bash
export SOCKET_API_KEY=your_api_key_here
depscore
```

### Global Installation

To install the tool globally and make the `depscore` command available system-wide:

```bash
npm install -g .
```

After global installation, you can use the `depscore` command from anywhere:

```bash
export SOCKET_API_KEY=your_api_key_here
depscore
```
