import express from "express";
import {
  createIncentiveProgram,
  updateIncentiveProgram,
  getAllIncentivePrograms,
  getIncentiveProgramById,
  deleteIncentiveProgram
} from "../controllers/incentiveProgramController";
import { verifyAuthorization } from "../middleware/verifyAuthorization";

const router = express.Router();

// Route to create a new incentive program
router.post("/incentive", express.json(), verifyAuthorization, createIncentiveProgram);

// Route to update an existing incentive program
router.put("/incentive", express.json(), verifyAuthorization, updateIncentiveProgram);

// Route to get all incentive programs
router.get("/incentive", verifyAuthorization, getAllIncentivePrograms);

// Route to get an incentive program by store ID
router.get("/incentive/:storeId", verifyAuthorization, getIncentiveProgramById);

// Route to delete an incentive program by store ID
router.delete("/incentive", express.json(), verifyAuthorization, deleteIncentiveProgram);

export { router as incentiveRoutes };
