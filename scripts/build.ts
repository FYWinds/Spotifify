/**
 * Single-binary build in two steps:
 *  1. Bundle to one JS file with a plugin that stubs `react-devtools-core` (Ink imports it only when
 *     DEV=true, but the bundler still has to resolve it).
 *  2. `bun build --compile` the flat bundle; nothing bare is left to resolve at runtime.
 *
 * Usage: bun run scripts/build.ts [--target bun-windows-x64] [--outfile dist/spotifify]
 * `--target` accepts any `bun build --compile --target` value, so release builds cross-compile from one host.
 */
import { rm } from "node:fs/promises";

const argv = Bun.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const target = flag("--target");
const outfile = flag("--outfile") ?? "dist/spotifify";
const bundle = `${outfile}.bundle.js`;

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  target: "bun",
  outdir: ".",
  naming: bundle,
  plugins: [
    {
      name: "stub-react-devtools",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default { connectToDevTools() {} };", loader: "js" }));
      },
    },
  ],
});
if (!result.success) {
  for (const m of result.logs) console.error(m.message);
  process.exit(1);
}

const args = ["build", "--compile", "--outfile", outfile];
if (target) args.push(`--target=${target}`);
const compile = Bun.spawn(["bun", ...args, bundle], { stdout: "inherit", stderr: "inherit" });
const code = await compile.exited;
await rm(bundle, { force: true });
process.exit(code);
