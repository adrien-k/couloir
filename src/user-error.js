class UserError extends Error {
  constructor(message) {
    super(message);
    this.isUserError = true;
  }
}

export default UserError;
