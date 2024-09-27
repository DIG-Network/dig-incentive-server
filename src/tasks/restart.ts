import { Task, SimpleIntervalJob } from "toad-scheduler";

// We have an issue where the payments gets stuck and I havnt figured out why yet.
// This will just restart the incentive process every hour to refresh it if it gets stuck.

const task = new Task("restart", async () => {
  console.log("Doing routine restart. This is normal.");
  process.exit(0);
});

const job = new SimpleIntervalJob(
  {
    hours: 1,
    runImmediately: false,
  },
  task,
  { id: "restart", preventOverrun: true }
);

export default job;
