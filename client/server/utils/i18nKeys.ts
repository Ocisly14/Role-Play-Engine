/**
 * Backend i18n Translation Keys
 *
 * These keys are returned by the backend API and translated on the frontend
 * based on the user's language preference.
 *
 * Usage in controllers:
 * ```typescript
 * res.json({
 *   success: true,
 *   messageKey: I18N_KEYS.GAME_STARTED,
 *   messageParams: { characterName: 'John' },
 *   data: ...
 * });
 * ```
 *
 * Frontend handling:
 * ```typescript
 * const { t } = useTranslation();
 * if (response.messageKey) {
 *   const message = t(response.messageKey, response.messageParams);
 *   showNotification(message);
 * }
 * ```
 */
export const I18N_KEYS = {
  // Authentication
  AUTH_INVALID_CREDENTIALS: 'auth.login.invalidCredentials',
  AUTH_EMAIL_EXISTS: 'auth.register.errors.emailExists',
  AUTH_REGISTRATION_FAILED: 'auth.register.errors.registrationFailed',
  AUTH_SESSION_EXPIRED: 'auth.login.sessionExpired',
  AUTH_LOGOUT_SUCCESS: 'auth.logout.success',
  AUTH_VERIFICATION_INVALID: 'auth.register.verify.invalid',
  AUTH_VERIFICATION_EXPIRED: 'auth.register.verify.expired',
  AUTH_VERIFICATION_SUCCESS: 'auth.register.verify.success',
  AUTH_PASSWORD_RESET_SUCCESS: 'auth.resetPassword.success',
  AUTH_PASSWORD_RESET_FAILED: 'auth.resetPassword.error',
  AUTH_INVALID_TOKEN: 'auth.resetPassword.invalidToken',

  // Game session
  GAME_STARTED: 'game.messages.gameStarted',
  GAME_STOPPED: 'game.messages.gameStopped',
  GAME_SESSION_NOT_FOUND: 'game.errors.sessionNotFound',
  GAME_ACTION_FAILED: 'game.errors.actionFailed',
  GAME_INVALID_ACTION: 'game.errors.invalidAction',

  // Checkpoint
  CHECKPOINT_SAVED: 'checkpoint.success.created',
  CHECKPOINT_LOADED: 'checkpoint.success.loaded',
  CHECKPOINT_DELETED: 'checkpoint.success.deleted',
  CHECKPOINT_BATCH_DELETED: 'checkpoint.success.batchDeleted',
  CHECKPOINT_NOT_FOUND: 'checkpoint.errors.notFound',
  CHECKPOINT_CREATE_FAILED: 'checkpoint.errors.createFailed',
  CHECKPOINT_LOAD_FAILED: 'checkpoint.errors.loadFailed',
  CHECKPOINT_DELETE_FAILED: 'checkpoint.errors.deleteFailed',
  CHECKPOINT_CORRUPTED: 'checkpoint.errors.corrupted',

  // Character
  CHARACTER_CREATED: 'character.form.success',
  CHARACTER_UPDATED: 'character.form.updateSuccess',
  CHARACTER_DELETED: 'home.characters.deleteSuccess',
  CHARACTER_CREATE_FAILED: 'character.form.failed',
  CHARACTER_UPDATE_FAILED: 'character.form.updateFailed',
  CHARACTER_DELETE_FAILED: 'home.characters.deleteFailed',
  CHARACTER_NAME_REQUIRED: 'character.validation.nameRequired',
  CHARACTER_OCCUPATION_REQUIRED: 'character.validation.occupationRequired',

  // Module
  MODULE_UPLOADED: 'module.success.uploaded',
  MODULE_DELETED: 'module.success.deleted',
  MODULE_LOADED: 'module.success.loaded',
  MODULE_UPLOAD_FAILED: 'module.errors.uploadFailed',
  MODULE_DELETE_FAILED: 'module.errors.deleteFailed',
  MODULE_LOAD_FAILED: 'module.errors.loadFailed',
  MODULE_NOT_FOUND: 'module.errors.notFound',
  MODULE_CORRUPTED: 'module.errors.corrupted',
  MODULE_INVALID_FORMAT: 'module.validation.invalidFormat',
  MODULE_MISSING_DIGEST: 'module.validation.missingDigest',
  MODULE_FILE_TOO_LARGE: 'module.validation.fileTooLarge',

  // Common errors
  ERROR_GENERIC: 'common.error.generic',
  ERROR_NETWORK: 'common.error.network',
  ERROR_UNAUTHORIZED: 'common.error.unauthorized',
  ERROR_NOT_FOUND: 'common.error.notFound',
  ERROR_SERVER: 'common.error.serverError',
  ERROR_INVALID_INPUT: 'common.error.invalidInput',
  ERROR_REQUIRED: 'common.error.required',

  // Common success
  SUCCESS_GENERIC: 'common.status.success',
  SETTINGS_SAVED: 'home.settings.saveSuccess',
} as const;

/**
 * Type for i18n keys
 */
export type I18nKey = typeof I18N_KEYS[keyof typeof I18N_KEYS];

/**
 * Interface for API responses with i18n support
 */
export interface I18nResponse<T = any> {
  success: boolean;
  messageKey?: I18nKey;
  messageParams?: Record<string, string | number>;
  data?: T;
  error?: string;
}
