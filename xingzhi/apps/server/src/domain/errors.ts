export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function notFound(message = '未找到对应记录。'): never {
  throw new AppError(404, 'NOT_FOUND', message);
}

export function forbidden(message = '没有访问此记录的权限。'): never {
  throw new AppError(403, 'FORBIDDEN', message);
}
