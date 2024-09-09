import _ from "lodash";
import { Task, SimpleIntervalJob } from "toad-scheduler";

import {
  ServerCoin,
  DigPeer,
  DigChallenge,
  DataStore,
  getStoresList,
} from "dig-sdk";

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
    console.log("!!!!");
    const rootHash = dataStore.Tree.getRoot();

    if (process.env.DIG_DEBUG === "1") {
      console.log("Root hash:", rootHash);
    }

    //const storeIntegrityCheck = await dataStore.validate();

    //if (process.env.DIG_DEBUG === "1") {
    //   console.log("Store integrity check:", storeIntegrityCheck);
    // }

    // if (!storeIntegrityCheck) {
    //   throw new Error(`Store ${program.storeId} failed integrity check.`);
    // }

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

    // Get the keys from the store
    const storeKeys = dataStore.Tree.listKeys(rootHash);
    const totalKeys = storeKeys.length;

    // Calculate the sample size needed for 90% confidence
    const sampleSize = calculateSampleSize(totalKeys);

    if (process.env.DIG_DEBUG === "1") {
      console.log(
        `Total keys: ${totalKeys}, Sampling ${sampleSize} keys for 90% confidence`
      );
    }

    // Randomly select keys based on the calculated sample size
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

    let winningPeer: DigPeer | null = null;

    // Loop until a valid peer is found or no more peers are available
    while (!winningPeer) {
      if (process.env.DIG_DEBUG === "1") {
        console.log("Sampling a peer from the current epoch...");
      }

      // Sample only one peer at a time
      const serverCoins = await serverCoin.sampleCurrentEpoch(1, peerBlackList);

      if (process.env.DIG_DEBUG === "1") {
        console.log("Server coins:", serverCoins);
      }

      // Exit if no peers are available
      if (serverCoins.length === 0) {
        console.log(`No more peers available for storeId ${program.storeId}`);
        return;
      }

      const peerIp = serverCoins[0];
      if (process.env.DIG_DEBUG === "1") {
        console.log(`Sampled peer: ${peerIp}`);
      }

      const digPeer = new DigPeer(peerIp, program.storeId);
      let response;
      try {
        response = await digPeer.contentServer.headStore();
      } catch (error: any) {
        console.error(`Failed to connect to peer ${peerIp}: ${error.message}`);
        await program.addToBlacklist(peerIp);
        continue; // Move to next peer
      }

      if (process.env.DIG_DEBUG === "1") {
        console.log(`Checking if peer ${peerIp} has the correct store...`);
      }

      let valid = false;

      if (response.success) {
        if (process.env.DIG_DEBUG === "1") {
          console.log(`Peer ${peerIp} responded successfully.`);
        }

        const peerGenerationHash = response.headers?.["x-generation-hash"];

        if ((peerGenerationHash as string) === rootHash) {
          console.log(
            `Peer ${peerIp} has the correct generation hash: ${peerGenerationHash}`
          );
          console.log(
            `Generating challenges for ${randomKeys.length} random keys for peer ${peerIp}...`
          );

          // Generate challenges for each random key
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

              // Send the challenge to the peer and get their response
              const peerChallengeResponse = await digPeer.contentServer.getKey(
                hexToUtf8(hexKey),
                rootHash,
                serializedChallenge
              );

              // Compute your own challenge response (the expected response)
              const expectedChallengeResponse =
                await digChallenge.createChallengeResponse(challenge);

              // Compare your response with the peer's response
              const isValid =
                peerChallengeResponse === expectedChallengeResponse;

              console.log(
                `Challenge for key ${hexKey} ${
                  isValid ? "passed" : "failed"
                } for peer ${peerIp}`
              );

              return isValid;
            } catch (error: any) {
              console.error(
                `Error during challenge for peer ${peerIp}: ${error.message}`
              );
              await program.addToBlacklist(peerIp);
              throw error; // Exit the loop on error
            }
          });

          // Check if all challenges are valid
          try {
            const challengeResults = await Promise.all(challengePromises);
            valid = challengeResults.every((result) => result);
            if (process.env.DIG_DEBUG === "1") {
              console.log(
                `Peer ${peerIp} ${
                  valid
                    ? "passed all challenges"
                    : "failed one or more challenges"
                }.`
              );
            }
          } catch (error: any) {
            console.error(
              `Challenge validation error for peer ${peerIp}: ${error.message}`
            );
            await program.addToBlacklist(peerIp);
            continue; // Move to next peer
          }
        } else {
          if (process.env.DIG_DEBUG === "1") {
            console.log(
              `Peer ${peerIp} has an incorrect generation hash: ${peerGenerationHash}`
            );
          }
        }
      } else {
        if (process.env.DIG_DEBUG === "1") {
          console.log(`Peer ${peerIp} did not respond successfully.`);
        }
      }

      if (valid) {
        winningPeer = digPeer;
        if (process.env.DIG_DEBUG === "1") {
          console.log(`Valid peer found: ${peerIp}`);
        }
      } else {
        if (process.env.DIG_DEBUG === "1") {
          console.log(
            `Peer ${peerIp} was not valid. Adding to blacklist and resampling...`
          );
        }
        await program.addToBlacklist(peerIp);
      }
    }

    // Send payout to the winning peer
    if (winningPeer) {
      console.log(
        `Sending XCH to ${winningPeer.IpAddress} for store ${program.storeId}...`
      );

      await winningPeer.sendPayment(program.walletName, rewardThisRound);
      console.log(`Payout sent to peer: ${winningPeer.IpAddress}`);

      await program.setLastEpochPaid(currentEpoch);
      await program.incrementTotalRoundsCompleted(1);
      await program.incrementPaymentTotal(rewardThisRound);
      console.log(
        `Payout process completed for peer: ${winningPeer.IpAddress}`
      );
    }
  } catch (error: any) {
    console.error(`Error during incentive program: ${error.message}`);
    throw error; // Ensure any error exits the process properly
  }
};

// Function to run payouts for all stores
const runPayouts = async (): Promise<void> => {
  const currentEpoch = ServerCoin.getCurrentEpoch();
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
