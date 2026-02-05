## Package Security (Socket)

### Rules
- Before installing any package, check it with the `check_package` MCP tool.
  Pass the ecosystem, package name, and version. If version is unknown, use "unknown".
- If the verdict is FAIL, do NOT install the package. Suggest alternatives.
- If the verdict is WARN, inform the user of the risks before proceeding.
- When adding imports to source code, also check those packages with `check_package`.
  Imports indicate dependencies even if they aren't in the manifest yet.
- When writing code that introduces a new dependency, check it BEFORE writing the
  import statement.
- Use `batch_check` when adding multiple packages at once (more efficient than
  individual `check_package` calls).

### Available MCP Tools
- `check_package`: Single package check with verdict (PASS/WARN/FAIL), scores, and alerts
- `batch_check`: Check multiple packages at once with scores and alerts
- `explain_alert`: Get plain-language explanation of a Socket alert type
