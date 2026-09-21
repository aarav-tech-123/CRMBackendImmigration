import express from "express"
import { verifyToken, authorize } from "../../middleware/auth.middleware.js"
import { getAllLeadStatuses } from "../../controllers/utils/leadStatus.controller.js"


const router = express.Router()


router.get("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getAllLeadStatuses)



export default router;