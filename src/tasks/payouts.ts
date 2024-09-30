import _ from "lodash";
import { Task, SimpleIntervalJob } from "toad-scheduler";
import {
  ServerCoin,
  DigPeer,
  DigChallenge,
  DataStore,
  getStoresList,
  Environment,
} from "@dignetwork/dig-sdk";
import { Mutex } from "async-mutex";
import { IncentiveProgram } from "../utils/IncentiveProgram";
import { hexToUtf8 } from "../utils/hexUtils";

const mutex = new Mutex();

const roundsPerEpoch = 1008; // 1 round every 10 mins starting on the first hour of the epoch
const mojosPerXch = BigInt(1000000000000);

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

    console.log(`Root hash for current epoch: ${rootHash}`);

    const rewardThisRound =
      (BigInt(program.xchRewardPerEpoch) * mojosPerXch) /
      BigInt(roundsPerEpoch);

    console.log(`Reward for this round: ${rewardThisRound} mojos`);

    const peerBlackList = await program.getBlacklist();
    console.log(`Peer blacklist retrieved: ${peerBlackList.length} peers`);

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

    while (!payoutMade) {
      console.log("Sampling up to 50 peers from the current epoch...");

      const serverCoins = await serverCoin.sampleCurrentEpoch(
        50,
        peerBlackList
      );

      if (serverCoins.length === 0) {
        console.log(`No more peers available for storeId ${program.storeId}`);
        break;
      }

      console.log(`Sampled ${serverCoins.length} peers for challenge.`);

      for (const peerIp of serverCoins) {
        console.log(`Initiating challenge for peer: ${peerIp}`);
        const digPeer = new DigPeer(peerIp, program.storeId);

        try {
          // Timeout of 5 seconds for headStore request
          const response = await withTimeout(
            digPeer.contentServer.headStore(),
            10000,
            `headStore timed out for peer ${peerIp}`
          );
          console.log(`Peer ${peerIp} responded to headStore request`);

          const peerGenerationHash = response.headers?.["x-generation-hash"];
          if (peerGenerationHash === rootHash) {
            console.log(`Peer ${peerIp} has correct generation hash.`);

            const challengePromises = randomKeysHex.map(async (hexKey) => {
              try {
                const digChallenge = new DigChallenge(
                  program.storeId,
                  hexKey,
                  rootHash
                );
                const seed = DigChallenge.generateSeed();
                const challenge = await digChallenge.generateChallenge(seed);
                const serializedChallenge =
                  DigChallenge.serializeChallenge(challenge);

                // Timeout of 5 seconds for getKey request
                const peerChallengeResponse = await withTimeout(
                  digPeer.contentServer.getKey(
                    hexToUtf8(hexKey),
                    rootHash,
                    serializedChallenge
                  ),
                  10000,
                  `getKey timed out for peer ${peerIp}`
                );

                const expectedChallengeResponse =
                  await digChallenge.createChallengeResponse(challenge);

                console.log(`${peerIp} - ${hexToUtf8(hexKey)} - ${peerChallengeResponse} - ${expectedChallengeResponse}`);

                return peerChallengeResponse === expectedChallengeResponse;
              } catch (error: any) {
                console.error(
                  `Error during challenge for peer ${peerIp}: ${error.message}`
                );
                return false;
              }
            });

            const challengeResults = await Promise.all(challengePromises);
            const valid = challengeResults.every((result) => result);

            if (valid) {
              validPeers.push(digPeer);
              console.log(`Peer ${peerIp} passed all challenges and is valid.`);
            } else {
              console.log(`Peer ${peerIp} failed one or more challenges.`);
            }
          } else {
            console.log(`Peer ${peerIp} has an incorrect generation hash.`);
          }
        } catch (error: any) {
          console.error(`Error with peer ${peerIp}: ${error.message}`);
          // Skip this peer and continue to the next
        }
      }

      if (validPeers.length > 0) {
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
        //const memo = [paymentHint, message];
        const memos = [message];

        console.log(`Sending equal bulk payments to ${paymentAddresses.length} valid peers...`);
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
 * Function to run payouts for all stores
 */
const runPayouts = async (): Promise<void> => {
  const { epoch: currentEpoch } = ServerCoin.getCurrentEpoch();
  const storeList = getStoresList();

  console.log(`Running payouts for epoch: ${currentEpoch}`);
  console.log(`Store list: ${storeList.join(", ")}`);

  for (const storeId of storeList) {
    console.log(`Starting payouts for storeId: ${storeId}`);
    const program = await IncentiveProgram.from(storeId);
    if (program?.active) {
      console.log(`Program active for storeId: ${storeId}`);
      await runIncentiveProgram(program, currentEpoch);
    } else {
      console.log(`Program inactive for storeId: ${storeId}`);
    }
  }
};

// Task that runs at a regular interval to handle payouts
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

const job = new SimpleIntervalJob(
  {
    minutes: 10,
    runImmediately: true,
  },
  task,
  { id: "payouts", preventOverrun: true }
);

export default job;
