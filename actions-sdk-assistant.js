/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * This is the class that handles the converstaion API directly from Assistant, providing
 * implementation for all the methods available in the API.
 */

'use strict';

const Debug = require('debug');
const debug = Debug('actions-on-google:debug');
const error = Debug('actions-on-google:error');
const transformToSnakeCase = require('./utils/transform').transformToSnakeCase;
const assistant = require('./assistant');
const Assistant = assistant.Assistant;
const State = assistant.State;

// Constants
const CONVERSATION_API_AGENT_VERSION_HEADER = 'Agent-Version-Label';
const RESPONSE_CODE_OK = 200;
const INPUTS_MAX = 3;

// Configure logging for hosting platforms that only support console.log and console.error
debug.log = console.log.bind(console);
error.log = console.error.bind(console);

// ---------------------------------------------------------------------------
//                   Actions SDK support
// ---------------------------------------------------------------------------

/**
 * Constructor for ActionsSdkAssistant object. To be used in the Actions SDK
 * HTTP endpoint logic.
 *
 * @example
 * const ActionsSdkAssistant = require('actions-on-google').ActionsSdkAssistant;
 * const assistant = new ActionsSdkAssistant({request: request, response: response,
 *   sessionStarted:sessionStarted});
 *
 * @param {Object} options JSON configuration.
 * @param {Object} options.request Express HTTP request object.
 * @param {Object} options.response Express HTTP response object.
 * @param {Function=} options.sessionStarted Function callback when session starts.
 * @actionssdk
 */
const ActionsSdkAssistant = class extends Assistant {
  constructor (options) {
    debug('ActionsSdkAssistant constructor');
    super(options);

    if (this.body_ &&
        this.body_.conversation &&
        this.body_.conversation.type &&
        this.body_.conversation.type === this.ConversationStages.NEW &&
        this.sessionStarted_ && typeof this.sessionStarted_ === 'function') {
      this.sessionStarted_();
    } else if (this.sessionStarted_ && typeof this.sessionStarted_ !== 'function') {
      this.handleError_('options.sessionStarted must be a Function');
    }
  }

  /*
   * Gets the request Conversation API version.
   *
   * @example
   * const assistant = new ActionsSdkAssistant({request: request, response: response});
   * const apiVersion = assistant.getApiVersion();
   *
   * @return {string} Version value or null if no value.
   * @actionssdk
   */
  getApiVersion () {
    debug('getApiVersion');
    return this.apiVersion_ || this.actionsApiVersion_;
  }

  /**
   * Gets the user's raw input query.
   *
   * @example
   * const assistant = new ActionsSdkAssistant({request: request, response: response});
   * assistant.tell('You said ' + assistant.getRawInput());
   *
   * @return {string} User's raw query or null if no value.
   * @actionssdk
   */
  getRawInput () {
    debug('getRawInput');
    const input = this.getTopInput_();
    if (!input) {
      this.handleError_('Failed to get top Input.');
      return null;
    }
    if (!input.rawInputs || input.rawInputs.length === 0) {
      this.handleError_('Missing user raw input');
      return null;
    }
    const rawInput = input.rawInputs[0];
    if (!rawInput.query) {
      this.handleError_('Missing query for user raw input');
      return null;
    }
    return rawInput.query;
  }

  /**
   * Gets previous JSON dialog state that the action sent to Assistant.
   * Alternatively, use the assistant.data field to store JSON values between requests.
   *
   * @example
   * const assistant = new ActionsSdkAssistant({request: request, response: response});
   * const dialogState = assistant.getDialogState();
   *
   * @return {Object} JSON object provided to the Assistant in the previous
   *     user turn or {} if no value.
   * @actionssdk
   */
  getDialogState () {
    debug('getDialogState');
    if (this.body_.conversation && this.body_.conversation.conversationToken) {
      return JSON.parse(this.body_.conversation.conversationToken);
    }
    return {};
  }

  /**
   * Gets the {@link User} object.
   * The user object contains information about the user, including
   * a string identifier and personal information (requires requesting permissions,
   * see {@link Assistant#askForPermissions|askForPermissions}).
   *
   * @example
   * const assistant = new ActionsSdkAssistant({request: request, response: response});
   * const userId = assistant.getUser().userId;
   *
   * @return {User} Null if no value.
   * @actionssdk
   */
  getUser () {
    debug('getUser');
    if (!this.body_.user) {
      this.handleError_('No user object');
      return null;
    }
    // User object includes original API properties
    const user = {
      userId: this.body_.user.userId,
      user_id: this.body_.user.userId,
      userName: this.body_.user.profile ? {
        displayName: this.body_.user.profile.displayName,
        givenName: this.body_.user.profile.givenName,
        familyName: this.body_.user.profile.familyName
      } : null,
      profile: this.body_.user.profile,
      accessToken: this.body_.user.accessToken,
      access_token: this.body_.user.accessToken
    };
    return user;
  }

  /**
   * If granted permission to device's location in previous intent, returns device's
   * location (see {@link Assistant#askForPermissions|askForPermissoins}).
   * If device info is unavailable, returns null.
   *
   * @example
   * const assistant = new ActionsSdkAssistant({request: req, response: res});
   * assistant.askForPermission("To get you a ride",
   *   assistant.SupportedPermissions.DEVICE_PRECISE_LOCATION);
   * // ...
   * // In response handler for subsequent intent:
   * if (assistant.isPermissionGranted()) {
   *   sendCarTo(assistant.getDeviceLocation().coordinates);
   * }
   *
   * @return {DeviceLocation} Null if location permission is not granted.
   * @actionssdk
   */
  getDeviceLocation () {
    debug('getDeviceLocation');
    if (!this.body_.device || !this.body_.device.location) {
      return null;
    }
    const deviceLocation = {
      coordinates: this.body_.device.location.coordinates,
      address: this.body_.device.location.formattedAddress,
      zipCode: this.body_.device.location.zipCode,
      city: this.body_.device.location.city
    };
    return deviceLocation;
  }

  /**
   * Returns true if the request follows a previous request asking for
   * permission from the user and the user granted the permission(s). Otherwise,
   * false. Use with {@link Assistant#askForPermissions|askForPermissions}.
   *
   * @example
   * const assistant = new ActionsSdkAssistant({request: request, response: response});
   * assistant.askForPermissions("To get you a ride", [
   *   assistant.SupportedPermissions.NAME,
   *   assistant.SupportedPermissions.DEVICE_PRECISE_LOCATION
   * ]);
   * // ...
   * // In response handler for subsequent intent:
   * if (assistant.isPermissionGranted()) {
   *  // Use the requested permission(s) to get the user a ride
   * }
   *
   * @return {boolean} true if permissions granted.
   * @actionssdk
   */
  isPermissionGranted () {
    debug('isPermissionGranted');
    return this.getArgument(this.BuiltInArgNames.PERMISSION_GRANTED) === 'true';
  }

  /**
   * Gets the "versionLabel" specified inside the Action Package.
   * Used by actions to do version control.
   *
   * @example
   * const assistant = new ActionsSdkAssistant({request: request, response: response});
   * const actionVersionLabel = assistant.getActionVersionLabel();
   *
   * @return {string} The specified version label or null if unspecified.
   * @actionssdk
   */
  getActionVersionLabel () {
    debug('getActionVersionLabel');
    const versionLabel = this.request_.get(CONVERSATION_API_AGENT_VERSION_HEADER);
    if (versionLabel) {
      return versionLabel;
    } else {
      return null;
    }
  }

  /**
   * Gets the unique conversation ID. It's a new ID for the initial query,
   * and stays the same until the end of the conversation.
   *
   * @example
   * const assistant = new ActionsSdkAssistant({request: request, response: response});
   * const conversationId = assistant.getConversationId();
   *
   * @return {string} Conversation ID or null if no value.
   * @actionssdk
   */
  getConversationId () {
    debug('getConversationId');
    if (!this.body_.conversation || !this.body_.conversation.conversationId) {
      this.handleError_('No conversation ID');
      return null;
    }
    return this.body_.conversation.conversationId;
  }

  /**
   * Get the current intent. Alternatively, using a handler Map with
   * {@link Assistant#handleRequest|handleRequest}, the client library will
   * automatically handle the incoming intents.
   *
   * @example
   * const assistant = new ActionsSdkAssistant({request: request, response: response});
   *
   * function responseHandler (assistant) {
   *   const intent = assistant.getIntent();
   *   switch (intent) {
   *     case assistant.StandardIntents.MAIN:
   *       const inputPrompt = assistant.buildInputPrompt(false, 'Welcome to action snippets! Say anything.');
   *       assistant.ask(inputPrompt);
   *       break;
   *
   *     case assistant.StandardIntents.TEXT:
   *       assistant.tell('You said ' + assistant.getRawInput());
   *       break;
   *   }
   * }
   *
   * assistant.handleRequest(responseHandler);
   *
   * @return {string} Intent id or null if no value.
   * @actionssdk
   */
  getIntent () {
    debug('getIntent');
    const input = this.getTopInput_();
    if (!input) {
      this.handleError_('Missing intent from request body');
      return null;
    }
    return input.intent;
  }

  /**
   * Get the argument value by name from the current intent. If the argument
   * is not a text argument, the entire argument object is returned.
   *
   * Note: If incoming request is using an API version under 2 (e.g. 'v1'),
   * the argument object will be in Proto2 format (snake_case, etc).
   *
   * @param {string} argName Name of the argument.
   * @return {string} Argument value matching argName
   *     or null if no matching argument.
   * @actionssdk
   */
  getArgument (argName) {
    debug('getArgument: argName=%s', argName);
    if (!argName) {
      this.handleError_('Invalid argument name');
      return null;
    }
    const argument = this.getArgument_(argName);
    if (!argument) {
      debug('Failed to get argument value: %s', argName);
      return null;
    } else if (argument.textValue) {
      return argument.textValue;
    } else {
      if (!this.isNotApiVersionOne_()) {
        return transformToSnakeCase(argument);
      } else {
        return argument;
      }
    }
  }

  /**
   * Asks Assistant to collect user's input; all user's queries need to be sent to
   * the action.
   *
   * @example
   * const assistant = new ActionsSdkAssistant({request: request, response: response});
   *
   * function mainIntent (assistant) {
   *   const inputPrompt = assistant.buildInputPrompt(true, '<speak>Hi! <break time="1"/> ' +
   *         'I can read out an ordinal like ' +
   *         '<say-as interpret-as="ordinal">123</say-as>. Say a number.</speak>',
   *         ['I didn\'t hear a number', 'If you\'re still there, what\'s the number?', 'What is the number?']);
   *   assistant.ask(inputPrompt);
   * }
   *
   * function rawInput (assistant) {
   *   if (assistant.getRawInput() === 'bye') {
   *     assistant.tell('Goodbye!');
   *   } else {
   *     const inputPrompt = assistant.buildInputPrompt(true, '<speak>You said, <say-as interpret-as="ordinal">' +
   *       assistant.getRawInput() + '</say-as></speak>',
   *         ['I didn\'t hear a number', 'If you\'re still there, what\'s the number?', 'What is the number?']);
   *     assistant.ask(inputPrompt);
   *   }
   * }
   *
   * const actionMap = new Map();
   * actionMap.set(assistant.StandardIntents.MAIN, mainIntent);
   * actionMap.set(assistant.StandardIntents.TEXT, rawInput);
   *
   * assistant.handleRequest(actionMap);
   *
   * @param {Object} inputPrompt Holding initial and no-input prompts.
   * @param {Object=} dialogState JSON object the action uses to hold dialog state that
   *     will be circulated back by Assistant.
   * @return The response that is sent to Assistant to ask user to provide input.
   * @actionssdk
   */
  ask (inputPrompt, dialogState) {
    debug('ask: inputPrompt=%s, dialogState=%s',
       JSON.stringify(inputPrompt), JSON.stringify(dialogState));
    if (!inputPrompt) {
      this.handleError_('Invalid input prompt');
      return null;
    }
    if (typeof inputPrompt === 'string') {
      inputPrompt = this.buildInputPrompt(this.isSsml_(inputPrompt), inputPrompt);
    }
    if (!dialogState) {
      dialogState = {
        'state': (this.state instanceof State ? this.state.getName() : this.state),
        'data': this.data
      };
    } else if (Array.isArray(dialogState)) {
      this.handleError_('Invalid dialog state');
      return null;
    }
    const expectedIntent = this.buildExpectedIntent_(this.StandardIntents.TEXT, []);
    return this.buildAskHelper_(inputPrompt, [expectedIntent], dialogState);
  }

  /**
   * Tells Assistant to render the speech response and close the mic.
   *
   * @example
   * const assistant = new ActionsSdkAssistant({request: request, response: response});
   *
   * function mainIntent (assistant) {
   *   const inputPrompt = assistant.buildInputPrompt(true, '<speak>Hi! <break time="1"/> ' +
   *         'I can read out an ordinal like ' +
   *         '<say-as interpret-as="ordinal">123</say-as>. Say a number.</speak>',
   *         ['I didn\'t hear a number', 'If you\'re still there, what\'s the number?', 'What is the number?']);
   *   assistant.ask(inputPrompt);
   * }
   *
   * function rawInput (assistant) {
   *   if (assistant.getRawInput() === 'bye') {
   *     assistant.tell('Goodbye!');
   *   } else {
   *     const inputPrompt = assistant.buildInputPrompt(true, '<speak>You said, <say-as interpret-as="ordinal">' +
   *       assistant.getRawInput() + '</say-as></speak>',
   *         ['I didn\'t hear a number', 'If you\'re still there, what\'s the number?', 'What is the number?']);
   *     assistant.ask(inputPrompt);
   *   }
   * }
   *
   * const actionMap = new Map();
   * actionMap.set(assistant.StandardIntents.MAIN, mainIntent);
   * actionMap.set(assistant.StandardIntents.TEXT, rawInput);
   *
   * assistant.handleRequest(actionMap);
   *
   * @param {string} textToSpeech Final spoken response. Spoken response can be SSML.
   * @return The HTTP response that is sent back to Assistant.
   * @actionssdk
   */
  tell (textToSpeech) {
    debug('tell: textToSpeech=%s', textToSpeech);
    if (!textToSpeech) {
      this.handleError_('Invalid speech response');
      return null;
    }
    const finalResponse = {};
    if (this.isSsml_(textToSpeech)) {
      finalResponse.speechResponse = {
        ssml: textToSpeech
      };
    } else {
      finalResponse.speechResponse = {
        textToSpeech: textToSpeech
      };
    }
    const response = this.buildResponseHelper_(null, false, null, finalResponse);
    return this.doResponse_(response, RESPONSE_CODE_OK);
  }

  /**
   * Builds the {@link https://developers.google.com/actions/reference/conversation#InputPrompt|InputPrompt object}
   * from initial prompt and no-input prompts.
   *
   * The Assistant needs one initial prompt to start the conversation. If there is no user response,
   * the Assistant re-opens the mic and renders the no-input prompts three times
   * (one for each no-input prompt that was configured) to help the user
   * provide the right response.
   *
   * Note: we highly recommend action to provide all the prompts required here in order to ensure a
   * good user experience.
   *
   * @example
   * const inputPrompt = assistant.buildInputPrompt(false, 'Welcome to action snippets! Say a number.',
   *     ['Say any number', 'Pick a number', 'What is the number?']);
   * assistant.ask(inputPrompt);
   *
   * @param {boolean} isSsml Indicates whether the text to speech is SSML or not.
   * @param {string} initialPrompt The initial prompt the Assistant asks the user.
   * @param {Array<string>=} noInputs Array of re-prompts when the user does not respond (max 3).
   * @return {Object} An {@link https://developers.google.com/actions/reference/conversation#InputPrompt|InputPrompt object}.
   * @actionssdk
   */
  buildInputPrompt (isSsml, initialPrompt, noInputs) {
    debug('buildInputPrompt: isSsml=%s, initialPrompt=%s, noInputs=%s',
      isSsml, initialPrompt, noInputs);
    const initials = [];

    if (noInputs) {
      if (noInputs.length > INPUTS_MAX) {
        this.handleError_('Invalid number of no inputs');
        return null;
      }
    } else {
      noInputs = [];
    }

    this.maybeAddItemToArray_(initialPrompt, initials);
    if (isSsml) {
      return {
        initialPrompts: this.buildPromptsFromSsmlHelper_(initials),
        noInputPrompts: this.buildPromptsFromSsmlHelper_(noInputs)
      };
    } else {
      return {
        initialPrompts: this.buildPromptsFromPlainTextHelper_(initials),
        noInputPrompts: this.buildPromptsFromPlainTextHelper_(noInputs)
      };
    }
  }

// ---------------------------------------------------------------------------
//                   Private Helpers
// ---------------------------------------------------------------------------

  /**
   * Get the top most Input object.
   *
   * @return {object} Input object.
   * @private
   * @actionssdk
   */
  getTopInput_ () {
    debug('getTopInput_');
    if (!this.body_.inputs || this.body_.inputs.length === 0) {
      this.handleError_('Missing inputs from request body');
      return null;
    }
    return this.body_.inputs[0];
  }

  /**
   * Builds the response to send back to Assistant.
   *
   * @param {string} conversationToken The dialog state.
   * @param {boolean} expectUserResponse The expected user response.
   * @param {Object} expectedInput The expected response.
   * @param {boolean} finalResponse The final response.
   * @return {Object} Final response returned to server.
   * @private
   * @actionssdk
   */
  buildResponseHelper_ (conversationToken, expectUserResponse, expectedInput, finalResponse) {
    debug('buildResponseHelper_: conversationToken=%s, expectUserResponse=%s, ' +
      'expectedInput=%s, finalResponse=%s',
      conversationToken, expectUserResponse, JSON.stringify(expectedInput),
      JSON.stringify(finalResponse));
    const response = {};
    if (conversationToken) {
      response.conversationToken = conversationToken;
    }
    response.expectUserResponse = expectUserResponse;
    if (expectedInput) {
      response.expectedInputs = expectedInput;
    }
    if (!expectUserResponse && finalResponse) {
      response.finalResponse = finalResponse;
    }
    return response;
  }

  /**
   * Helper to add item to an array.
   *
   * @private
   * @actionssdk
   */
  maybeAddItemToArray_ (item, array) {
    debug('maybeAddItemToArray_: item=%s, array=%s', item, array);
    if (!array) {
      this.handleError_('Invalid array');
      return;
    }
    if (!item) {
      // ignore add
      return;
    }
    array.push(item);
  }

  /**
   * Get the argument by name from the current action.
   *
   * @param {string} argName Name of the argument.
   * @return {Object} Argument value matching argName
         or null if no matching argument.
   * @private
   * @actionssdk
   */
  getArgument_ (argName) {
    debug('getArgument_: argName=%s', argName);
    if (!argName) {
      this.handleError_('Invalid argument name');
      return null;
    }
    const input = this.getTopInput_();
    if (!input) {
      this.handleError_('Missing action');
      return null;
    }
    if (!arguments) {
      debug('No arguments included in request');
      return null;
    }
    for (let i = 0; i < input.arguments.length; i++) {
      if (input.arguments[i].name === argName) {
        return input.arguments[i];
      }
    }
    debug('Failed to find argument: %s', argName);
    return null;
  }

  /**
   * Extract session data from the incoming JSON request.
   *
   * @private
   * @actionssdk
   */
  extractData_ () {
    debug('extractData_');
    if (this.body_.conversation &&
      this.body_.conversation.conversationToken) {
      const json = JSON.parse(this.body_.conversation.conversationToken);
      this.data = json.data;
      this.state = json.state;
    } else {
      this.data = {};
    }
  }

  /**
   * Uses a PermissionsValueSpec object to construct and send a
   * permissions request to user.
   *
   * @param {Object} permissionsSpec PermissionsValueSpec object containing
   *     the permissions prefix and the permissions requested.
   * @param {Object} dialogState JSON object the action uses to hold dialog state that
   *     will be circulated back by Assistant.
   * @return {Object} HTTP response object.
   * @private
   * @actionssdk
   */
  fulfillPermissionsRequest_ (permissionsSpec, dialogState) {
    debug('fulfillPermissionsRequest_: permissionsSpec=%s, dialogState=%s',
      JSON.stringify(permissionsSpec), JSON.stringify(dialogState));
    // Build an Expected Intent object.
    const expectedIntent = {
      intent: this.StandardIntents.PERMISSION
    };
    if (this.isNotApiVersionOne_()) {
      expectedIntent.inputValueData = Object.assign({
        [this.ANY_TYPE_PROPERTY_]: this.InputValueDataTypes_.PERMISSION
      }, permissionsSpec);
    } else {
      expectedIntent.inputValueSpec = {
        permissionValueSpec: permissionsSpec
      };
    }
    // Send an Ask request to Assistant.
    const inputPrompt = this.buildInputPrompt(false, 'PLACEHOLDER_FOR_PERMISSION');
    if (!dialogState) {
      dialogState = {
        'state': (this.state instanceof State ? this.state.getName() : this.state),
        'data': this.data
      };
    }
    return this.buildAskHelper_(inputPrompt, [expectedIntent], dialogState);
  }

  /**
   * Builds the ask response to send back to Assistant.
   *
   * @param {Object} inputPrompt Holding initial and no-input prompts.
   * @param {Array} possibleIntents Array of ExpectedIntents.
   * @param {Object} dialogState JSON object the action uses to hold dialog state that
   *     will be circulated back by Assistant.
   * @return The response that is sent to Assistant to ask user to provide input.
   * @private
   * @actionssdk
   */
  buildAskHelper_ (inputPrompt, possibleIntents, dialogState) {
    debug('buildAskHelper_: inputPrompt=%s, possibleIntents=%s,  dialogState=%s',
      inputPrompt, possibleIntents, JSON.stringify(dialogState));
    if (!inputPrompt) {
      this.handleError_('Invalid input prompt');
      return null;
    }
    if (typeof inputPrompt === 'string') {
      inputPrompt = this.buildInputPrompt(this.isSsml_(inputPrompt), inputPrompt);
    }
    if (!dialogState) {
      dialogState = {
        'state': (this.state instanceof State ? this.state.getName() : this.state),
        'data': this.data
      };
    }
    const expectedInputs = [{
      inputPrompt: inputPrompt,
      possibleIntents: possibleIntents
    }];
    const response = this.buildResponseHelper_(
      JSON.stringify(dialogState),
      true, // expectedUserResponse
      expectedInputs,
      null // finalResponse is null b/c dialog is active
    );
    return this.doResponse_(response, RESPONSE_CODE_OK);
  }

  /**
   * Builds an ExpectedIntent object. Refer to {@link ActionsSdkAssistant#newRuntimeEntity} to create the list
   * of runtime entities required by this method. Runtime entities need to be defined in
   * the Action Package.
   *
   * @param {string} intent Developer specified in-dialog intent inside the Action
   *     Package or an Assistant built-in intent like
   *     'assistant.intent.action.TEXT'.
   * @return {Object} An {@link https://developers.google.com/actions/reference/conversation#ExpectedIntent|ExpectedIntent object}
         encapsulating the intent and the runtime entities.
   * @private
   * @actionssdk
   */
  buildExpectedIntent_ (intent) {
    debug('buildExpectedIntent_: intent=%s', intent);
    if (!intent || intent === '') {
      this.handleError_('Invalid intent');
      return null;
    }
    const expectedIntent = {
      intent: intent
    };
    return expectedIntent;
  }
};

module.exports = ActionsSdkAssistant;
