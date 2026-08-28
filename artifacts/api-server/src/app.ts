import express, {
  type Express,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";

import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";

const app: Express = express();

/* -------------------------------------------------------
 * Logging
 * ----------------------------------------------------- */
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

/* -------------------------------------------------------
 * CORS
 * ----------------------------------------------------- */
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

/* -------------------------------------------------------
 * Body / Cookie middleware
 * ----------------------------------------------------- */
app.use(cookieParser());

app.use(
  express.json({
    limit: "10mb",
  }),
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  }),
);

/* -------------------------------------------------------
 * Health check
 * IMPORTANT: keep this BEFORE authMiddleware
 * ----------------------------------------------------- */
app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "erp-api",
    message: "API is running",
  });
});

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "erp-api",
  });
});

/* -------------------------------------------------------
 * Authentication
 * ----------------------------------------------------- */
app.use(authMiddleware);

/* -------------------------------------------------------
 * API routes
 * ----------------------------------------------------- */
app.use("/api", router);

/* -------------------------------------------------------
 * 404 handler
 * ----------------------------------------------------- */
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    ok: false,
    error: "Route not found",
  });
});

/* -------------------------------------------------------
 * Error handler
 * ----------------------------------------------------- */
app.use(
  (
    err: unknown,
    _req: Request,
    res: Response,
    _next: express.NextFunction,
  ) => {
    logger.error({ err }, "Unhandled API error");

    res.status(500).json({
      ok: false,
      error: "Internal server error",
    });
  },
);

export default app;
