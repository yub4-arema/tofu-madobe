export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 500
  ) {
    super(message)
  }
}

export function errorDetails(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message, status: error.status }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unexpected error.",
    status: 500,
  }
}
