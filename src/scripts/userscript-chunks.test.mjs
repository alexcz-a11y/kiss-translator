import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

// config-overrides.js picks the webpack variant from REACT_APP_CLIENT at load time.
process.env.REACT_APP_CLIENT = "userscript";

const require = createRequire(import.meta.url);
const webpack = createRequire(require.resolve("react-scripts/package.json"))(
  "webpack"
);
const { webpack: configure } = require("../../config-overrides.js");

test("userscript entries inline dynamic imports instead of loading chunks from the host page", async () => {
  await fs.mkdir("tmp", { recursive: true });
  const root = await fs.mkdtemp(path.resolve("tmp/userscript-chunks-"));
  try {
    await fs.writeFile(
      path.join(root, "entry.js"),
      'globalThis.result = import("./lazy.js").then(m => m.value);'
    );
    // Shared by every entry, so LimitChunkCountPlugin alone cannot merge it.
    await fs.writeFile(
      path.join(root, "lazy.js"),
      `export const value = import("./nested.js").then(m => m.value); export const padding = "${"x".repeat(25000)}";`
    );
    await fs.writeFile(
      path.join(root, "nested.js"),
      "export const value = 42;"
    );
    const configured = configure(
      {
        output: {},
        module: { parser: {} },
        optimization: {},
        resolve: { alias: {} },
        plugins: [],
      },
      "production"
    );
    const entry = Object.fromEntries(
      Object.keys(configured.entry).map((name) => [
        name,
        path.join(root, "entry.js"),
      ])
    );
    const compiler = webpack({
      mode: "production",
      entry,
      module: configured.module,
      output: {
        ...configured.output,
        path: path.join(root, "dist"),
        filename: "[name].js",
      },
      optimization: { ...configured.optimization, minimize: false },
      plugins: configured.plugins.filter(
        (plugin) => plugin.constructor.name === "LimitChunkCountPlugin"
      ),
    });
    const stats = await new Promise((resolve, reject) => {
      compiler.run((error, stats) => {
        compiler.close((closeError) => {
          if (error || closeError) reject(error || closeError);
          else resolve(stats);
        });
      });
    });
    assert.equal(
      stats.hasErrors(),
      false,
      stats.toString({ all: false, errors: true })
    );
    for (const name of Object.keys(entry)) {
      const entrypoint = stats.compilation.entrypoints.get(name);
      assert.deepEqual(entrypoint.getFiles(), [`${name}.js`], name);
      assert.equal(
        entrypoint.getRuntimeChunk().getAllAsyncChunks().size,
        0,
        `${name} has no lazy chunks`
      );
      const script = await fs.readFile(
        path.join(root, "dist", `${name}.js`),
        "utf8"
      );
      const context = vm.createContext({
        document: {
          createElement() {
            throw new Error("Attempted to load a chunk through the host page");
          },
          getElementsByTagName() {
            throw new Error("Attempted to load a chunk through the host page");
          },
        },
      });
      context.self = context;
      vm.runInContext(script, context);
      assert.equal(await context.result, 42, name);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
