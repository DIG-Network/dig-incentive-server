import _ from "lodash";
import { Task, SimpleIntervalJob } from "toad-scheduler";
import { STORE_PATH, DataStore, NconfManager, DigNetwork } from "dig-sdk";
import { Mutex } from "async-mutex";
import { IncentiveProgram } from "../utils/IncentiveProgram";
import fs from "fs";
import path from "path";

const mutex = new Mutex();
const nconfManager = new NconfManager("subscriptions.json");

const runSubscriber = async (): Promise<void> => {
  const publicListings = await IncentiveProgram.fetchAllPublicListings();

  // Sort by 'xchRewardPerEpoch' in descending order
  const sortedPublicListings = _.orderBy(
    publicListings,
    ["xchRewardPerEpoch"],
    ["desc"]
  );

  console.log(
    "Sorted Public Listings by xchRewardPerEpoch:",
    sortedPublicListings
  );

  const currentSubscriptions =
    (await nconfManager.getConfigValue<string[]>("subscriptions")) || [];
  let totalDiskSpace = await DataStore.getTotalDiskSpace();

  // Assume unlimited disk space if DISK_SPACE_LIMIT is not set
  const diskSpaceLimit = process.env.DISK_SPACE_LIMIT
    ? parseInt(process.env.DISK_SPACE_LIMIT)
    : null;

  let subscriptionMade = false;

  // Subscribing to new listings (only once per iteration)
  for (const listing of sortedPublicListings) {
    if (subscriptionMade) {
      break; // Stop the loop after one successful subscription
    }

    const storePath = path.join(STORE_PATH, listing.storeId);
    console.log(`Store Path: ${storePath}`);

    // Skip if already subscribed or if the store directory already exists
    if (currentSubscriptions.includes(listing.storeId)) {
      console.log(`Store ${listing.storeId} is already subscribed.`);
      continue;
    }
    if (fs.existsSync(storePath)) {
      console.log(
        `Store directory for ${listing.storeId} already exists. Skipping...`
      );
      continue;
    }

    if (listing.storeId.length != 64) {
      console.log(`Invalid storeId: ${listing.storeId}. Skipping...`);
      continue;
    }

    const store = DataStore.from(listing.storeId);
    const coinInfo = await store.fetchCoinInfo();
    const bytes = coinInfo.latestStore.metadata.bytes;

    if (!bytes) {
      console.log(`Store ${listing.storeId} has no data. Skipping...`);
      continue;
    }

    // Check if there is enough disk space only if diskSpaceLimit is set
    if (
      diskSpaceLimit === null ||
      BigInt(totalDiskSpace) + bytes <= BigInt(diskSpaceLimit)
    ) {
      console.log(`Subscribing to store ${listing.storeId}...`);

      await DigNetwork.subscribeToStore(listing.storeId);

      // Add the storeId to subscriptions
      currentSubscriptions.push(listing.storeId);
      nconfManager.setConfigValue("subscriptions", currentSubscriptions);

      // Update total disk space
      totalDiskSpace += bytes;

      // Mark that a subscription has been made
      subscriptionMade = true;
      break; // Exit the loop after a successful subscription
    } else {
      console.log(
        `Not enough disk space to subscribe to store ${listing.storeId}.`
      );
    }
  }

  // Unsubscribing from non-existing listings
  for (const subscription of currentSubscriptions) {
    const isListed = sortedPublicListings.some(
      (listing) => listing.storeId === subscription
    );

    if (!isListed) {
      console.log(
        `Unsubscribing from store ${subscription}, public listing no longer available.`
      );

      DigNetwork.unsubscribeFromStore(subscription);

      // Remove the storeId from incentivezed subscriptions
      const index = currentSubscriptions.indexOf(subscription);
      if (index > -1) {
        currentSubscriptions.splice(index, 1);
        nconfManager.setConfigValue("subscriptions", currentSubscriptions);
      }
    }
  }

  console.log("Subscription process completed.");
};

const task = new Task("subscriber", async () => {
  if (!mutex.isLocked()) {
    const releaseMutex = await mutex.acquire();
    try {
      console.log("Starting subscriber task...");
      await runSubscriber();
      console.log("Subscriber task completed.");
    } catch (error: any) {
      console.error(`Error in subscriber task: ${error.message}`);
    } finally {
      releaseMutex();
    }
  }
});

const job = new SimpleIntervalJob(
  {
    minutes: 12,
    runImmediately: true,
  },
  task,
  { id: "subscriber", preventOverrun: true }
);

export default job;
