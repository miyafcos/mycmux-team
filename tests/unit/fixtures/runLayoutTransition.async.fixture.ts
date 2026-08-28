import { runLayoutTransition } from "../../../src/stores/groupingRuntimeStore";

runLayoutTransition("grouping-commit", async () => 1);
runLayoutTransition("grouping-commit", () => Promise.resolve(1));
runLayoutTransition("grouping-commit", () => ({ then() {} }));
