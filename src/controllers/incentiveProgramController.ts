import { Request, Response } from "express";
import { IncentiveProgram, IncentiveProgramData } from "../utils/IncentiveProgram";

// POST /incentive -> Creates a new incentive program
export const createIncentiveProgram = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const data: IncentiveProgramData = req.body;

    // Validate the incoming data
    if (!data.storeId || !data.xchRewardPerEpoch) {
      res.status(400).json({ error: "storeId and xchRewardPerEpoch are required." });
      return;
    }

    const existingProgram = await IncentiveProgram.from(data.storeId);
    if (existingProgram) {
      res.status(400).json({ error: `IncentiveProgram for storeId ${data.storeId} already exists.` });
      return;
    }

    IncentiveProgram.create(data);
    res.status(201).json({ message: "Incentive Program created successfully." });
  } catch (error) {
    console.error("An error occurred while creating the incentive program:", error);
    res.status(500).json({ error: "An error occurred while creating the incentive program." });
  }
};

// PUT /incentive -> Updates an existing incentive program
export const updateIncentiveProgram = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const data: IncentiveProgramData = req.body;

    // Validate the incoming data
    if (!data.storeId) {
      res.status(400).json({ error: "storeId is required." });
      return;
    }

    const existingProgram = await IncentiveProgram.from(data.storeId);
    if (!existingProgram) {
      res.status(404).json({ error: `IncentiveProgram for storeId ${data.storeId} does not exist.` });
      return;
    }

    // Update the program's properties
    if (data.xchRewardPerEpoch !== undefined) {
      await existingProgram.setReward(data.xchRewardPerEpoch);
    }
    if (data.active !== undefined) {
      if (data.active) {
        await existingProgram.activate();
      } else {
        await existingProgram.pause();
      }
    }

    res.status(200).json({ message: "Incentive Program updated successfully.", program: existingProgram });
  } catch (error) {
    console.error("An error occurred while updating the incentive program:", error);
    res.status(500).json({ error: "An error occurred while updating the incentive program." });
  }
};

// GET /incentive -> Gets all incentive programs
export const getAllIncentivePrograms = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const allPrograms = await IncentiveProgram.nconfManager.getConfigValue<{ [key: string]: IncentiveProgramData }>("");

    if (!allPrograms) {
      res.status(404).json({ error: "No incentive programs found." });
      return;
    }

    res.status(200).json({ programs: allPrograms });
  } catch (error) {
    console.error("An error occurred while retrieving all incentive programs:", error);
    res.status(500).json({ error: "An error occurred while retrieving all incentive programs." });
  }
};

// GET /incentive/:storeId -> Gets an incentive program by store ID
export const getIncentiveProgramById = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { storeId } = req.params;

    const program = await IncentiveProgram.from(storeId);

    if (!program) {
      res.status(404).json({ error: `IncentiveProgram for storeId ${storeId} not found.` });
      return;
    }

    res.status(200).json({ program });
  } catch (error) {
    console.error("An error occurred while retrieving the incentive program:", error);
    res.status(500).json({ error: "An error occurred while retrieving the incentive program." });
  }
};

// DELETE /incentive -> Deletes an incentive program from config
export const deleteIncentiveProgram = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { storeId } = req.body;

    // Validate the incoming data
    if (!storeId) {
      res.status(400).json({ error: "storeId is required." });
      return;
    }

    const existingProgram = await IncentiveProgram.from(storeId);
    if (!existingProgram) {
      res.status(404).json({ error: `IncentiveProgram for storeId ${storeId} does not exist.` });
      return;
    }

    await existingProgram.delete();
    res.status(200).json({ message: `IncentiveProgram for storeId ${storeId} deleted successfully.` });
  } catch (error) {
    console.error("An error occurred while deleting the incentive program:", error);
    res.status(500).json({ error: "An error occurred while deleting the incentive program." });
  }
};
