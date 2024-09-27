import { ToadScheduler, SimpleIntervalJob } from "toad-scheduler";
import payouts from './payouts' ;
import subscriber from './subscriber';
import restart from './restart';

type JobRegistry = {
  [key: string]: SimpleIntervalJob;
};

const scheduler = new ToadScheduler();
const jobRegistry: JobRegistry = {};

const addJobToScheduler = (job: SimpleIntervalJob): void => {
  if (job.id) {
    jobRegistry[job.id] = job;
    scheduler.addSimpleIntervalJob(job);
  }
};

const start = (): void => {
  // Add default jobs
  const defaultJobs: SimpleIntervalJob[] = [payouts, subscriber, restart];

  defaultJobs.forEach((defaultJob) => {
    if (defaultJob.id) {
      jobRegistry[defaultJob.id] = defaultJob;
      scheduler.addSimpleIntervalJob(defaultJob);
    }
  });
};

const getJobStatus = (): { [key: string]: string } => {
  return Object.keys(jobRegistry).reduce((status, key) => {
    status[key] = jobRegistry[key].getStatus();
    return status;
  }, {} as { [key: string]: string });
};

export default { start, addJobToScheduler, jobRegistry, getJobStatus };
