import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import mqttRouter from "./mqtt";
import weatherRouter from "./weather";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(mqttRouter);
router.use(weatherRouter);

export default router;
