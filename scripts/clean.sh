#!/bin/bash

# Clean script with configurable directory exclusions
# Usage: ./scripts/clean.sh [options]
# Options:
#   --dry-run    Show what would be deleted without actually deleting
#   --verbose    Show detailed output
#   --help       Show this help message

set -euo pipefail

# Maintainable list of directories to skip
SKIP_DIRS=(
    "node_modules"
    ".git"
    ".github"
    "build"
    "coverage"
    ".nyc_output"
    "dist"
    ".next"
    ".vscode"
    ".idea"
    "tmp"
    "temp"
)

# File patterns to clean (can be customized)
CLEAN_PATTERNS=(
    "*.d.ts"
    "*.js"
    "*.js.map"
    "*.d.ts.map"
)

# Files to preserve (exceptions)
PRESERVE_PATTERNS=(
    "*.config.js"
    "*-types.d.ts"
)

# Default options
DRY_RUN=false
VERBOSE=false
HELP=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            HELP=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Show help
if [[ "$HELP" == true ]]; then
    echo "Clean script with configurable directory exclusions"
    echo ""
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  --dry-run    Show what would be deleted without actually deleting"
    echo "  --verbose    Show detailed output"
    echo "  --help       Show this help message"
    echo ""
    echo "Directories that will be skipped:"
    printf "  %s\n" "${SKIP_DIRS[@]}"
    echo ""
    echo "File patterns that will be cleaned:"
    printf "  %s\n" "${CLEAN_PATTERNS[@]}"
    echo ""
    echo "File patterns that will be preserved:"
    printf "  %s\n" "${PRESERVE_PATTERNS[@]}"
    exit 0
fi

# Build the find command with directory exclusions
build_find_command() {
    local cmd="find ."

    # Add directory exclusions
    for dir in "${SKIP_DIRS[@]}"; do
        cmd="$cmd \\( -path \"./$dir\" -o -path \"*/$dir\" \\) -prune -o"
    done

    # Add file pattern matching
    cmd="$cmd \\("
    for i in "${!CLEAN_PATTERNS[@]}"; do
        if [[ $i -gt 0 ]]; then
            cmd="$cmd -o"
        fi
        cmd="$cmd -name \"${CLEAN_PATTERNS[$i]}\""
    done
    cmd="$cmd \\) -type f"

    # Add preserve pattern exclusions
    for pattern in "${PRESERVE_PATTERNS[@]}"; do
        cmd="$cmd ! -name \"$pattern\""
    done

    cmd="$cmd -print"
    echo "$cmd"
}

# Function to log messages
log() {
    if [[ "$VERBOSE" == true ]]; then
        echo "$1"
    fi
}

# Function to execute or show command
execute_or_show() {
    local cmd="$1"
    if [[ "$DRY_RUN" == true ]]; then
        echo "[DRY RUN] Would execute: $cmd"
        eval "$cmd" | head -10
        local count=$(eval "$cmd" | wc -l)
        echo "[DRY RUN] Found $count files that would be deleted"
    else
        log "Executing: $cmd"
        eval "$cmd" | while read -r file; do
            if [[ -f "$file" ]]; then
                log "Removing: $file"
                rm -f "$file"
            fi
        done
    fi
}

# Main execution
main() {
    local project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    cd "$project_root"

    echo "Cleaning generated files in: $project_root"

    if [[ "$DRY_RUN" == true ]]; then
        echo "[DRY RUN MODE] - No files will be deleted"
    fi

    echo "Skipping directories: ${SKIP_DIRS[*]}"
    echo "Cleaning patterns: ${CLEAN_PATTERNS[*]}"
    echo "Preserving patterns: ${PRESERVE_PATTERNS[*]}"
    echo ""

    local find_cmd=$(build_find_command)
    execute_or_show "$find_cmd"

    if [[ "$DRY_RUN" == false ]]; then
        echo "Cleanup completed!"
    fi
}

# Run main function
main "$@"
