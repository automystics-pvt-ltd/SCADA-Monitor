import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mqttRouter from "./mqtt";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mqttRouter);

export default router;
