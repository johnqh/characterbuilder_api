import {
  ERROR_STATUS,
  type ApiErrorCode,
} from '@sudobility/characterbuilder_types';

/** Thrown by services; app.onError turns it into the error envelope with the code's fixed status. */
export class HttpError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly headers?: Record<string, string>
  ) {
    super(message);
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}
