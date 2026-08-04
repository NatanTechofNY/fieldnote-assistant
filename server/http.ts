import type { Response } from "express";

export type Success<T> = { success: true; data: T };

export const success = <T>(res: Response, data: T, statusCode = 200): Response<Success<T>> =>
  res.status(statusCode).json({ success: true, data });

export const failure = (res: Response, statusCode: number, error: string): Response =>
  res.status(statusCode).json({ success: false, error });
