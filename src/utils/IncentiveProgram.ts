import { NconfManager, FullNodePeer, Wallet, ServerCoin } from "@dignetwork/dig-sdk";
import { IncentiveProgramData } from "@dignetwork/dig-sdk/dist/types";

import {
  ServerCoin as ServerCoinDriver,
  getCoinId,
  morphLauncherId,
  signCoinSpends,
  createServerCoin,
  CoinSpend,
} from "datalayer-driver";

class IncentiveProgram {
  private data: IncentiveProgramData;
  public static nconfManager = new NconfManager("payment_programs.json");
  private static blacklistManager = new NconfManager("blacklist.json");
  private static readonly FIXED_STORE_ID =
    "ee634738d4744907cc2b1180d324726066bcff138932fbc51f218f4f72eaf1e9";

  // Private constructor to prevent direct instantiation
  private constructor(data: IncentiveProgramData) {
    this.data = data;
  }

  // Static method to load an existing IncentiveProgram
  public static async from(storeId: string): Promise<IncentiveProgram | null> {
    const programData =
      await IncentiveProgram.nconfManager.getConfigValue<IncentiveProgramData>(
        storeId
      );
    if (programData) {
      return new IncentiveProgram(programData);
    }
    return null;
  }

  // Static method to create a new IncentiveProgram
  public static async create(
    data: IncentiveProgramData
  ): Promise<IncentiveProgram> {
    const existingProgram = await this.from(data.storeId);
    if (existingProgram) {
      throw new Error(
        `IncentiveProgram for storeId ${data.storeId} already exists.`
      );
    }

    const currentEpoch = ServerCoin.getCurrentEpoch();
    const incentiveCoin = await IncentiveProgram.createCoinForEpoch(data);
    data.currentCoin = {
      coin: {
        amount: incentiveCoin.coin.amount.toString(),
        parentCoinInfo: incentiveCoin.coin.parentCoinInfo.toString("hex"),
        puzzleHash: incentiveCoin.coin.puzzleHash.toString("hex"),
      },
      epoch: currentEpoch,
      createdAt: new Date().toISOString(),
    };

    await this.nconfManager.setConfigValue(data.storeId, data);

    return new IncentiveProgram(data);
  }

  // Getters for the data properties
  public get storeId(): string {
    return this.data.storeId;
  }

  public get xchRewardPerEpoch(): number {
    return this.data.xchRewardPerEpoch;
  }

  public get totalRoundsCompleted(): number | undefined {
    return this.data.totalRoundsCompleted;
  }

  public get paymentTotalToDate(): bigint | undefined {
    return this.data.paymentTotalToDate;
  }

  public get active(): boolean {
    return this.data.active;
  }

  public get lastEpochPaid(): number | undefined {
    return this.data.lastEpochPaid;
  }

  public get walletName(): string {
    return this.data.walletName;
  }

  public async maybeRefreshIncentiveCoin(): Promise<void> {
    const currentEpoch = ServerCoin.getCurrentEpoch();

    if (this.data.currentCoin?.epoch !== currentEpoch) {
      const incentiveCoin = await IncentiveProgram.createCoinForEpoch(
        this.data
      );

      this.clearBlacklist();

      this.data.currentCoin = {
        coin: {
          amount: incentiveCoin.coin.amount.toString(),
          parentCoinInfo: incentiveCoin.coin.parentCoinInfo.toString("hex"),
          puzzleHash: incentiveCoin.coin.puzzleHash.toString("hex"),
        },
        epoch: currentEpoch,
        createdAt: new Date().toISOString(),
      };

      await IncentiveProgram.nconfManager.setConfigValue(
        this.data.storeId,
        this.data
      );
    }
  }

  // Method to activate the incentive program
  public async activate(): Promise<void> {
    this.maybeRefreshIncentiveCoin();
    this.data.active = true;
    await this.save();
  }

  // Method to pause the incentive program
  public async pause(): Promise<void> {
    await IncentiveProgram.melt(this.data);
    this.data.active = false;
    await this.save();
  }

  // Method to delete the incentive program
  public async delete(): Promise<void> {
    await IncentiveProgram.melt(this.data);
    await IncentiveProgram.nconfManager.deleteConfigValue(this.data.storeId);
    await IncentiveProgram.blacklistManager.deleteConfigValue(
      this.data.storeId
    );
  }

  // Method to set the reward per epoch
  public async setReward(xchRewardPerEpoch: number): Promise<void> {
    this.data.xchRewardPerEpoch = xchRewardPerEpoch;
    await this.save();
  }

  // Method to increment the paymentTotalToDate by a specific amount
  public async incrementPaymentTotal(amount: bigint): Promise<void> {
    this.data.paymentTotalToDate =
      (this.data.paymentTotalToDate
        ? BigInt(this.data.paymentTotalToDate)
        : BigInt(0)) + amount;
    await this.save();
  }

  // Method to increment the totalRoundsCompleted by a specific number
  public async incrementTotalRoundsCompleted(count: number): Promise<void> {
    this.data.totalRoundsCompleted =
      (this.data.totalRoundsCompleted || 0) + count;
    await this.save();
  }

  // Method to set the lastEpochPaid and reset blacklist if necessary
  public async setLastEpochPaid(epoch: number): Promise<void> {
    if (this.data.lastEpochPaid !== epoch) {
      this.data.lastEpochPaid = epoch;
      // Reset the blacklist for this store ID
      await IncentiveProgram.blacklistManager.setConfigValue(
        this.data.storeId,
        []
      );
    }
    await this.save();
  }

  public async clearBlacklist(): Promise<void> {
    await IncentiveProgram.blacklistManager.setConfigValue(
      this.data.storeId,
      []
    );
  }

  public async getBlacklist(): Promise<string[]> {
    const blacklist: string[] =
      (await IncentiveProgram.blacklistManager.getConfigValue<string[]>(
        this.data.storeId
      )) || [];
    return blacklist;
  }

  // Method to add an IP address to the blacklist
  public async addToBlacklist(ipAddress: string): Promise<void> {
    const currentBlacklist: string[] =
      (await IncentiveProgram.blacklistManager.getConfigValue(
        this.data.storeId
      )) || [];
    if (!currentBlacklist.includes(ipAddress)) {
      currentBlacklist.push(ipAddress);
      await IncentiveProgram.blacklistManager.setConfigValue(
        this.data.storeId,
        currentBlacklist
      );
    }
  }

  // Private method to save the current state of the incentive program to nconf
  private async save(): Promise<void> {
    const serializedData = JSON.stringify(this.data, (key, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      return value;
    });

    await IncentiveProgram.nconfManager.setConfigValue(
      this.data.storeId,
      JSON.parse(serializedData)
    );
  }

  public static async createCoinForEpoch(
    data: IncentiveProgramData
  ): Promise<ServerCoinDriver> {
    try {
      console.log("Creating Incentive Coin for Epoch...");

      // Custom logic for IncentiveCoin creation can be added here
      const peer = await FullNodePeer.connect();
      const wallet = await Wallet.load(data.walletName);
      const publicSyntheticKey = await wallet.getPublicSyntheticKey();
      const serverCoinCreationCoins = await wallet.selectUnspentCoins(
        peer,
        BigInt(300_000_000), // This value can differ for IncentiveCoin
        BigInt(1000000),
        []
      );

      // For IncentiveCoin, you may want to modify the epoch or other parameters
      const currentEpoch = ServerCoin.getCurrentEpoch();
      const epochBasedHint = morphLauncherId(
        Buffer.from(IncentiveProgram.FIXED_STORE_ID, "hex"),
        BigInt(currentEpoch)
      );

      // Create the incentive coin using custom parameters or use base logic
      const newIncentiveCoin = createServerCoin(
        publicSyntheticKey,
        serverCoinCreationCoins,
        epochBasedHint,
        [data.storeId, data.xchRewardPerEpoch.toString()],
        BigInt(300_000_000), // IncentiveCoin collateral can differ
        BigInt(1000000)
      );

      const combinedCoinSpends = [
        ...(newIncentiveCoin.coinSpends as CoinSpend[]),
      ];

      // Sign the coin spends
      const sig = signCoinSpends(
        combinedCoinSpends,
        [await wallet.getPrivateSyntheticKey()],
        false
      );

      const err = await peer.broadcastSpend(combinedCoinSpends, [sig]);

      if (err) {
        if (err.includes("no spendable coins")) {
          console.log("No coins available. Retrying in 5 seconds...");
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return this.createCoinForEpoch(data);
        }
        throw new Error(err);
      }

      console.log("Incentive Coin successfully created.");

      await FullNodePeer.waitForConfirmation(
        getCoinId(serverCoinCreationCoins[0])
      );

      return newIncentiveCoin.serverCoin;
    } catch (error: any) {
      console.error("Error creating Incentive Coin:", error.message);
      throw new Error("Failed to create incentive coin: " + error.message);
    }
  }

  public static async melt(data: IncentiveProgramData): Promise<void> {
    if (!data.currentCoin) {
      throw new Error("No current coin available to melt.");
    }

    const peer = await FullNodePeer.connect();
    const wallet = await Wallet.load(data.walletName);
    const publicSyntheticKey = await wallet.getPublicSyntheticKey();

    const feeCoins = await wallet.selectUnspentCoins(peer, BigInt(0), BigInt(1000000), []);

    const coin = {
      amount: BigInt(data.currentCoin.coin.amount),
      puzzleHash: Buffer.from(data.currentCoin.coin.puzzleHash, "hex"),
      parentCoinInfo: Buffer.from(data.currentCoin.coin.parentCoinInfo, "hex"),
    };

    const incentiveCoinId = getCoinId(coin);

    console.log("Melt Coin ID: ", incentiveCoinId.toString("hex"));

    const spendBundle = await peer.lookupAndSpendServerCoins(
      publicSyntheticKey,
      [coin, ...feeCoins],
      BigInt(1000000),
      false
    );

    const sig = signCoinSpends(
      spendBundle,
      [await wallet.getPrivateSyntheticKey()],
      false
    );

    const err = await peer.broadcastSpend(spendBundle, [sig]);

    if (err) {
      throw new Error(err);
    }

    await FullNodePeer.waitForConfirmation(incentiveCoinId);

    delete data.currentCoin;
    await this.nconfManager.setConfigValue(data.storeId, data);
  }

  public static async fetchAllPublicListings(): Promise<
    { storeId: string; xchRewardPerEpoch: number }[]
  > {
    const currentEpoch = ServerCoin.getCurrentEpoch();
    const epochBasedHint = morphLauncherId(
      Buffer.from(IncentiveProgram.FIXED_STORE_ID, "hex"),
      BigInt(currentEpoch)
    );

    const peer = await FullNodePeer.connect();
    const maxClvmCost = BigInt(11_000_000_000);

    const hintedCoinStates = await peer.getHintedCoinStates(
      epochBasedHint,
      false
    );

    // Use an object to store aggregated rewards by storeId
    const incentivizedStores: Record<string, number> = {};

    // Iterate over each hinted coin state
    for (const coinState of hintedCoinStates) {
      const serverCoin = await peer.fetchServerCoin(coinState, maxClvmCost);

      // Extract storeId and reward from serverCoin's memo URLs
      const storeId = serverCoin.memoUrls[0];
      const reward = parseFloat(serverCoin.memoUrls[1]);

      // Aggregate rewards for the same storeId
      if (incentivizedStores[storeId]) {
        incentivizedStores[storeId] += reward; // Add to existing reward
      } else {
        incentivizedStores[storeId] = reward; // Create new entry
      }
    }

    // Convert the aggregated result into an array of objects
    return Object.entries(incentivizedStores).map(([storeId, reward]) => ({
      storeId,
      xchRewardPerEpoch: reward,
    }));
  }
}

export { IncentiveProgram, IncentiveProgramData };
