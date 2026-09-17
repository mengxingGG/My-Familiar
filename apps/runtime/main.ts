import { bootstrap } from "../shared/bootstrap.ts";
void bootstrap(
  process.argv.includes("--controller") ? "controller" : "runtime",
);
