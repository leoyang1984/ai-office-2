export class OfficeError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const missing = () => new OfficeError(404, 'NOT_FOUND', '资源不存在');
export const denied = () => new OfficeError(403, 'FORBIDDEN', '无权执行此操作');
export const badRequest = (message: string) => new OfficeError(400, 'INVALID_INPUT', message);
export const conflict = (message: string) => new OfficeError(409, 'CONFLICT', message);
