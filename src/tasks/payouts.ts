import _ from "lodash";
import { Task, SimpleIntervalJob } from "toad-scheduler";
import {
  ServerCoin,
  DigPeer,
  DigChallenge,
  DataStore,
  getStoresList,
  Environment,
  asyncPool,
} from "@dignetwork/dig-sdk";
import { Mutex } from "async-mutex";
import { IncentiveProgram } from "../utils/IncentiveProgram";
import { hexToUtf8 } from "../utils/hexUtils";

const mutex = new Mutex();

const roundsPerEpoch = 1008; // 1 round every 10 mins starting on the first hour of the epoch
const mojosPerXch = BigInt(1000000000000);

/**
 * Request queue that holds all the network requests (getKey, headStore)
 */
type RequestTask = () => Promise<any>;
type RequestCallback = (result: any) => void;

interface RequestQueueItem {
  task: RequestTask;
  callback: RequestCallback;
}

const requestQueue: RequestQueueItem[] = [];

/**
 * Adds a request task to the global queue.
 * @param task The request task to be added.
 * @param callback The callback to be invoked with the result.
 */
const addToRequestQueue = (task: RequestTask, callback: RequestCallback) => {
  requestQueue.push({ task, callback });
};

/**
 * Continuously processes the request queue in controlled batches.
 * This runs in the background, without blocking.
 * @param limit The number of requests to process simultaneously.
 */
const processRequestQueue = async (limit: number) => {
  while (true) {
    if (requestQueue.length > 0) {
      const batch = requestQueue.splice(0, limit);
      await asyncPool(limit, batch, async (item) => {
        const result = await item.task();
        item.callback(result);
      });
    } else {
      // If no requests are in the queue, delay a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};

/**
 * Helper function to add a timeout to a promise.
 * @param promise The original promise.
 * @param ms Timeout in milliseconds.
 * @param timeoutMessage The error message when the timeout is reached.
 * @returns Promise that resolves before the timeout or rejects with an error.
 */
const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string
): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(timeoutMessage)), ms)
    ),
  ]);
};

/**
 * Calculates the sample size as 5% of total keys.
 * @param totalKeys Number of total keys.
 * @returns Sample size.
 */
const calculateSampleSize = (totalKeys: number): number => {
  return Math.ceil(totalKeys * 0.05);
};

/**
 * Cache to store the expected challenges for each peer for the current round.
 */
const challengeCache: Map<string, string> = new Map();

/**
 * Generates and caches the expected challenge response.
 * @param storeId The store ID.
 * @param hexKey The key.
 * @param rootHash The root hash.
 * @returns The expected challenge response.
 */
const getExpectedChallengeResponse = async (
  storeId: string,
  hexKey: string,
  rootHash: string
): Promise<string> => {
  const cacheKey = `${storeId}-${hexKey}-${rootHash}`;

  if (challengeCache.has(cacheKey)) {
    return challengeCache.get(cacheKey) as string;
  }

  const digChallenge = new DigChallenge(storeId, hexKey, rootHash);
  const seed = DigChallenge.generateSeed();
  const challenge = await digChallenge.generateChallenge(seed);
  const serializedChallenge = DigChallenge.serializeChallenge(challenge);

  const expectedChallengeResponse = await digChallenge.createChallengeResponse(
    challenge
  );

  challengeCache.set(cacheKey, expectedChallengeResponse);

  return serializedChallenge;
};

/**
 * Runs the incentive program.
 * @param program The incentive program.
 * @param currentEpoch The current epoch.
 */
const runIncentiveProgram = async (
  program: IncentiveProgram,
  currentEpoch: number
): Promise<void> => {
  try {
    if (!Environment.DIG_FOLDER_PATH) {
      throw new Error("DIG_FOLDER_PATH environment variable not set.");
    }

    console.log(`Incentive program started for storeId: ${program.storeId}`);
    console.log(`Current epoch: ${currentEpoch}`);

    const dataStore = DataStore.from(program.storeId);
    const rootHistory = await dataStore.getRootHistory();
    const rootHash = rootHistory[rootHistory.length - 1].root_hash;

    const rewardThisRound =
      (BigInt(program.xchRewardPerEpoch) * mojosPerXch) /
      BigInt(roundsPerEpoch);

    console.log(`Reward for this round: ${rewardThisRound} mojos`);

    const peerBlackList = await program.getBlacklist();
    console.log(`DIG Peer blacklist retrieved: ${peerBlackList.length} peers`);

    const serverCoin = new ServerCoin(program.storeId);
    const storeKeys = dataStore.Tree.listKeys(rootHash);
    const totalKeys = storeKeys.length;

    console.log(`Total keys in store: ${totalKeys}`);

    const sampleSize = calculateSampleSize(totalKeys);
    const randomKeysHex =
      sampleSize > 0 ? _.sampleSize(storeKeys, sampleSize) : storeKeys;
    const randomKeys = randomKeysHex.map(hexToUtf8);

    if (randomKeys.length === 0) {
      throw new Error("No keys found for challenge.");
    }

    let validPeers: DigPeer[] = [];
    let payoutMade = false;

    // Track requests we care about for this run
    const pendingRequests: Promise<boolean>[] = [];

    while (!payoutMade) {
      const serverCoins = await serverCoin.getActiveEpochPeers(peerBlackList);

      if (serverCoins.length === 0) {
        console.log(
          `No more dig peers available for storeId ${program.storeId}`
        );
        break;
      }

      console.log(`Requesting ${serverCoins.length} DIG Peers for challenge proof.`);

      // Add network requests (headStore and getKey) to the shared request queue
      for (const peerIp of serverCoins) {
        console.log(`Initiating challenge for DIG peer: ${peerIp}`);
        const digPeer = new DigPeer(peerIp, program.storeId);

        // Track request results in the current run
        pendingRequests.push(
          new Promise((resolve) => {
            addToRequestQueue(
              async () => {
                try {
                  // Add headStore request to the queue
                  const response = await withTimeout(
                    digPeer.contentServer.headStore(),
                    60000,
                    `headStore timed out for Dig peer ${peerIp}`
                  );

                  const peerGenerationHash =
                    response.headers?.["x-generation-hash"];
                  if (peerGenerationHash === rootHash) {
                    // Use Promise.all so that any failure immediately marks the peer as invalid
                    await Promise.all(
                      randomKeysHex.map(async (hexKey) => {
                        const digChallenge = new DigChallenge(
                          program.storeId,
                          hexKey,
                          rootHash
                        );
                        const seed = DigChallenge.generateSeed();
                        const challenge = await digChallenge.generateChallenge(
                          seed
                        );
                        const serializedChallenge =
                          DigChallenge.serializeChallenge(challenge);

                        // Send the serialized challenge to the peer
                        const peerChallengeResponse = await withTimeout(
                          digPeer.contentServer.getKey(
                            hexToUtf8(hexKey),
                            rootHash,
                            serializedChallenge
                          ),
                          10000,
                          `getKey timed out for dig peer ${peerIp}`
                        );

                        // Create the expected challenge response locally
                        const expectedChallengeResponse =
                          await digChallenge.createChallengeResponse(challenge);

                        // Compare the peer's response with the expected response
                        if (
                          peerChallengeResponse !== expectedChallengeResponse
                        ) {
                          throw new Error(
                            `Challenge response does not match for peer ${peerIp}`
                          );
                        }
                      })
                    );

                    validPeers.push(digPeer);
                    console.log(
                      `DIG Peer ${peerIp} passed all challenge proofs and is valid.`
                    );
                    resolve(true);
                  } else {
                    console.log(
                      `DIG Peer ${peerIp} has failed one or more challenges proofs.`
                    );
                    resolve(false);
                  }
                } catch (error: any) {
                  console.error(`Error with peer ${peerIp}: ${error.message}`);
                  resolve(false); // Skip this peer and continue to the next
                }
              },
              (result) => {
                // The callback processes the result
               // console.log(`Callback for peer ${peerIp}, result: ${result}`);
              }
            );
          })
        );
      }

      // Wait for all pending requests for this program to complete
      const results = await Promise.all(pendingRequests);
      const validCount = results.filter((result) => result === true).length;

      if (validCount > 0) {
        const paymentAddresses = Array.from(
          new Set(
            (
              await Promise.all(
                validPeers.map(
                  async (peer) => await peer.contentServer.getPaymentAddress()
                )
              )
            ).filter((address) => address !== null)
          )
        );

        const { epoch: currentEpoch, round: currentRound } =
          ServerCoin.getCurrentEpoch();
        const paymentHint = DigPeer.createPaymentHint(
          Buffer.from(program.storeId, "hex")
        );
        const message = Buffer.from(
          `DIG Network payout: Store Id ${program.storeId}, Epoch ${currentEpoch}, Round ${currentRound}`,
          "utf-8"
        );
        console.log(
          `Payment hint: ${paymentHint.toString("hex")} - ${message.toString(
            "utf-8"
          )}`
        );
        // For the alpha program we are going to forgo the hint and just use the message so people can see it in their chia wallet
        const memos = [paymentHint, message];

        console.log(
          `Sending equal bulk payments to ${paymentAddresses.length} valid DIG peers...`
        );
        await DigPeer.sendEqualBulkPayments(
          program.walletName,
          paymentAddresses,
          rewardThisRound,
          memos
        );

        payoutMade = true;
        console.log(
          `Payout made to ${validPeers.length} peers for a total of ${rewardThisRound} mojos.`
        );
        await program.setLastEpochPaid(currentEpoch);
        await program.incrementTotalRoundsCompleted(1);
        await program.incrementPaymentTotal(rewardThisRound);
      }

      if (validPeers.length === 0 && serverCoins.length === 0) {
        console.log("No valid peers found and no more peers available.");
        break;
      }
    }
  } catch (error: any) {
    console.error(`Error during incentive program: ${error.message}`);
    throw error;
  }
};

/**
 * Function to run payouts for all stores concurrently.
 */
const runPayouts = async (): Promise<void> => {
  const { epoch: currentEpoch } = ServerCoin.getCurrentEpoch();
  const storeList = getStoresList();

  console.log(`Running payouts for epoch: ${currentEpoch}`);
  console.log(`Store list: ${storeList.join(", ")}`);

  // Use asyncPool to process stores concurrently (with a limit of 5 stores at a time)
  await asyncPool(5, storeList, async (storeId) => {
    const program = await IncentiveProgram.from(storeId);
    if (program?.active) {
      console.log(`Starting payouts for storeId: ${storeId}`);
      await runIncentiveProgram(program, currentEpoch);
    }
  });
};

// Task that runs at a regular interval to handle payouts.
const task = new Task("payouts", async () => {
  if (!mutex.isLocked()) {
    const releaseMutex = await mutex.acquire();
    try {
      console.log("Starting payouts task...");
      await runPayouts();
      console.log("Payouts task completed.");
    } catch (error: any) {
      console.error(`Error in payouts task: ${error.message}`);
    } finally {
      releaseMutex(); // Ensure mutex is always released
    }
  } else {
    console.log("Payouts task skipped because the mutex is locked.");
  }
});

// Schedule the payouts job to run every 10 minutes
const job = new SimpleIntervalJob(
  {
    minutes: 10,
    runImmediately: true,
  },
  task,
  { id: "payouts", preventOverrun: true }
);

// Start processing the global request queue
processRequestQueue(10); // Fire and forget

export default job;
