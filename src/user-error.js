class UserError extends Error {
  constructor(message, { status = 400, statusMessage = "Bad Request" } = {}) {
    super(message);
    this.isUserError = true;
    this.status = status;
    this.statusMessage = statusMessage;
  }
}

export default UserError;
