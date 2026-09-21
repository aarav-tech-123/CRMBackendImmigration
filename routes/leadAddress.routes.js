import express from "express"
import { verifyToken, authorize } from "../middleware/auth.middleware.js"
import { createLeadAddress, getLeadAddressesByLeadId, getLeadAddressById, updateLeadAddress, deleteLeadAddress  } from "../controllers/leadAddress.controller.js"

const router = express.Router()

router.post("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), createLeadAddress)
router.get("/:id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getLeadAddressById)
router.get("/lead/:lead_id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getLeadAddressesByLeadId)
router.put("/:id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), updateLeadAddress)
router.delete("/:id", verifyToken, authorize(["SuperAdmin"]), deleteLeadAddress)



export default router