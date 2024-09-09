import express from "express";
import {
  createIncentiveProgram,
  updateIncentiveProgram,
  getAllIncentivePrograms,
  getIncentiveProgramById,
  deleteIncentiveProgram
} from "../controllers/incentiveProgramController";

const router = express.Router();

// Route to create a new incentive program
router.post("/incentive", express.json(), createIncentiveProgram);

// Route to update an existing incentive program
router.put("/incentive", express.json(), updateIncentiveProgram);

// Route to get all incentive programs
router.get("/incentive", getAllIncentivePrograms);

// Route to get an incentive program by store ID
router.get("/incentive/:storeId", getIncentiveProgramById);

// Route to delete an incentive program by store ID
router.delete("/incentive", express.json(), deleteIncentiveProgram);

export { router as incentiveRoutes };
