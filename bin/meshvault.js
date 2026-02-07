#!/usr/bin/env node

/**
 * MeshVault NPM entry point.
 *
 * This script launches the MeshVault Python backend server.
 * It requires Python 3.10+ and the meshvault pip package to be installed.
 *
 * Usage:
 *   npx meshvault
 *   npx meshvault --port 9000
 */

const { execSync, spawn } = require("child_process");
const path = require("path");

const PORT = process.env.PORT || process.argv.find((a, i) => process.argv[i - 1] === "--port") || 8420;

// Check if Python is available
function findPython() {
    for (const cmd of ["python3", "python"]) {
        try {
            const version = execSync(`${cmd} --version`, { encoding: "utf-8" }).trim();
            if (version.includes("3.")) return cmd;
        } catch { /* continue */ }
    }
    return null;
}

const python = findPython();
if (!python) {
    console.error("\n  ❌ Python 3.10+ is required but not found.");
    console.error("  Install it from https://python.org\n");
    process.exit(1);
}

// Check if meshvault is installed as a pip package
try {
    execSync(`${python} -c "import backend.app"`, {
        cwd: __dirname.replace(/\/bin$/, ""),
        stdio: "ignore",
    });
} catch {
    console.log("\n  📦 Installing MeshVault Python dependencies...\n");
    try {
        execSync(`${python} -m pip install meshvault --quiet`, { stdio: "inherit" });
    } catch {
        console.error("\n  ❌ Failed to install meshvault. Try: pip install meshvault\n");
        process.exit(1);
    }
}

// Launch the server
const env = { ...process.env, PORT: String(PORT) };
const server = spawn(python, ["-m", "backend.app"], {
    cwd: __dirname.replace(/\/bin$/, ""),
    env,
    stdio: "inherit",
});

server.on("error", (err) => {
    console.error(`\n  ❌ Failed to start MeshVault: ${err.message}\n`);
    process.exit(1);
});

server.on("close", (code) => {
    process.exit(code || 0);
});

// Forward termination signals
process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGTERM"));
