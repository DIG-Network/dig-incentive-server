import _ from "lodash";
import { Task, SimpleIntervalJob } from "toad-scheduler";

import {
  ServerCoin,
  DigPeer,
  DigChallenge,
  DataStore,
  getStoresList,
} from "@dignetwork/dig-sdk";

import { Mutex } from "async-mutex";
import { IncentiveProgram } from "../utils/IncentiveProgram";
import { hexToUtf8 } from "../utils/hexUtils";

const mutex = new Mutex();

const roundsPerEpoch = 1008; // 1 round every 10 mins starting on the first hour of the epoch
const mojosPerXch = BigInt(1000000000000);

const Z = 1.645; // Z-score for 90% confidence level
const p = 0.5; // Estimated proportion of the population with the attribute
const E = 0.1; // Margin of error (10%)

// Helper function to calculate sample size based on total keys and 90% confidence
const calculateSampleSize = (totalKeys: number): number => {
  const numerator = Z ** 2 * p * (1 - p);
  const denominator = E ** 2;
  const sampleSize = numerator / denominator;
  const adjustedSampleSize =
    (sampleSize * totalKeys) / (sampleSize + totalKeys - 1);

  return Math.ceil(adjustedSampleSize);
};

const runIncentiveProgram = async (
  program: IncentiveProgram,
  currentEpoch: number
): Promise<void> => {
  try {
    if (!process.env.DIG_FOLDER_PATH) {
      throw new Error("DIG_FOLDER_PATH environment variable not set.");
    }

    console.log(program);

    const dataStore = DataStore.from(program.storeId);
    const rootHash = dataStore.Tree.getRoot();

    if (process.env.DIG_DEBUG === "1") {
      console.log("Root hash:", rootHash);
    }

    const rewardThisRound =
      (BigInt(program.xchRewardPerEpoch) * mojosPerXch) /
      BigInt(roundsPerEpoch);

    if (process.env.DIG_DEBUG === "1") {
      console.log(`Reward for this round: ${rewardThisRound} mojos`);
    }

    const peerBlackList = await program.getBlacklist();

    if (process.env.DIG_DEBUG === "1") {
      console.log("Peer blacklist:", peerBlackList);
    }

    const serverCoin = new ServerCoin(program.storeId);
    const storeKeys = dataStore.Tree.listKeys(rootHash);
    const totalKeys = storeKeys.length;

    const sampleSize = calculateSampleSize(totalKeys);
    if (process.env.DIG_DEBUG === "1") {
      console.log(
        `Total keys: ${totalKeys}, Sampling ${sampleSize} keys for 90% confidence`
      );
    }

    const randomKeysHex =
      sampleSize > 0 ? _.sampleSize(storeKeys, sampleSize) : storeKeys;
    const randomKeys = randomKeysHex.map(hexToUtf8);

    if (randomKeys.length === 0) {
      throw new Error("No keys found.");
    }

    if (process.env.DIG_DEBUG === "1") {
      console.log(
        `Selected ${randomKeys.length} keys for challenge generation.`
      );
    }

    let validPeers: DigPeer[] = [];
    let payoutMade = false;

    // Loop until a payment is made or no more peers are available
    while (!payoutMade) {
      if (process.env.DIG_DEBUG === "1") {
        console.log("Sampling up to 50 peers from the current epoch...");
      }

      // Sample up to 50 peers
      const serverCoins = await serverCoin.sampleCurrentEpoch(
        50,
        peerBlackList
      );

      if (process.env.DIG_DEBUG === "1") {
        console.log("Server coins:", serverCoins);
      }

      if (serverCoins.length === 0) {
        console.log(`No more peers available for storeId ${program.storeId}`);
        break;
      }

      for (const peerIp of serverCoins) {
        const digPeer = new DigPeer(peerIp, program.storeId);
        let response;
        try {
          response = await digPeer.contentServer.headStore();
        } catch (error: any) {
          console.error(
            `Failed to connect to peer ${peerIp}: ${error.message}`
          );
          await program.addToBlacklist(peerIp);
          continue;
        }

        if (response.success) {
          const peerGenerationHash = response.headers?.["x-generation-hash"];
          if (peerGenerationHash === rootHash) {
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
                const peerChallengeResponse =
                  await digPeer.contentServer.getKey(
                    hexToUtf8(hexKey),
                    rootHash,
                    serializedChallenge
                  );
                const expectedChallengeResponse =
                  await digChallenge.createChallengeResponse(challenge);
                return peerChallengeResponse === expectedChallengeResponse;
              } catch (error: any) {
                console.error(
                  `Error during challenge for peer ${peerIp}: ${error.message}`
                );
                await program.addToBlacklist(peerIp);
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
              await program.addToBlacklist(peerIp);
            }
          } else {
            console.log(`Peer ${peerIp} has an incorrect generation hash.`);
          }
        } else {
          console.log(`Peer ${peerIp} did not respond successfully.`);
        }
      }

      if (validPeers.length > 0) {
        console.log(`Valid peers found: ${validPeers.length}`);
        const paymentAddresses = Array.from(
          new Set(
            await Promise.all(
              validPeers.map(
                async (peer) => await peer.contentServer.getPaymentAddress()
              )
            )
          )
        );
        

        // Create a memo for the payment, storeId for the hint for easy lookup
        const { epoch: currentEpoch, round: currentRound } = ServerCoin.getCurrentEpoch();
        const paymentHint = DigPeer.createPaymentHint(Buffer.from(program.storeId, "hex"));
        const memo = [paymentHint, Buffer.from(`Incentive program payout for storeId: ${program.storeId}, epoch ${currentEpoch}, round ${currentRound}`, "utf-8")];

        await DigPeer.sendEqualBulkPayments(
          program.walletName,
          paymentAddresses,
          rewardThisRound,
          memo
        );

        payoutMade = true; // Mark that payment was made
        await program.setLastEpochPaid(currentEpoch);
        await program.incrementTotalRoundsCompleted(1);
        await program.incrementPaymentTotal(rewardThisRound);
        console.log(`Payout process completed for ${validPeers.length} peers.`);
      }

      // If no valid peers were found and more peers are available, continue sampling
      if (validPeers.length === 0 && serverCoins.length === 0) {
        console.log("No valid peers found and no more peers available.");
        break;
      }
    }
  } catch (error: any) {
    console.error(`Error during incentive program: ${error.message}`);
    throw error; // Ensure any error exits the process properly
  }
};

// Function to run payouts for all stores
const runPayouts = async (): Promise<void> => {
  const { epoch: currentEpoch } = ServerCoin.getCurrentEpoch();
  const storeList = getStoresList();

  console.log({ currentEpoch, storeList });

  for (const storeId of storeList) {
    const program = await IncentiveProgram.from(storeId);
    if (program?.active) {
      console.log(
        `Running payouts for store ${storeId}, current epoch: ${currentEpoch}`
      );
      await runIncentiveProgram(program, currentEpoch);
    }
  }
};

// Task that runs at a regular interval to save the public IP
const task = new Task("payouts", async () => {
  if (!mutex.isLocked()) {
    const releaseMutex = await mutex.acquire();
    try {
      console.log("Starting payouts task...");
      await runPayouts();
      console.log("payouts task completed.");
    } catch (error: any) {
      console.error(`Error in payouts task: ${error.message}`);
    } finally {
      releaseMutex(); // Ensure mutex is always released
    }
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
