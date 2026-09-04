import { render } from "ink";
import { createElement } from "react";
import type { Matcher } from "../match/matcher.ts";
import type { Repo } from "../state/repo.ts";
import { App } from "./App.tsx";
import { loadQueue } from "./model.ts";

export interface ReviewDeps {
  repo: Repo;
  matcher: Matcher;
  market: string;
}

/** Runs the interactive review; resolves when the user quits. Every decision is already persisted by then. */
export async function runReviewTui(deps: ReviewDeps): Promise<{ decided: number }> {
  const initialQueues = { review: loadQueue(deps.repo, "review"), local: loadQueue(deps.repo, "local") };
  let decided = 0;
  const app = render(
    createElement(App, {
      repo: deps.repo,
      matcher: deps.matcher,
      market: deps.market,
      initialQueues,
      onExit: (n: number) => {
        decided = n;
      },
    }),
  );
  // Ink wires its exit resolver lazily: waitUntilExit() must be pending before exit() runs, i.e. before any key arrives.
  await app.waitUntilExit();
  return { decided };
}
