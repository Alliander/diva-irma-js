/*!
 * diva-irma-js
 * Module that manages connection with IRMA API Server
 * Copyright(c) 2017 Alliander, Koen van Ingen, Timen Olthof
 * BSD 3-Clause License
 */

const divaStateModule = require('./diva-state');

let divaConfig;
let divaState;

/**
* Module dependencies.
* @private
*/

const BPromise = require('bluebird');
const jwt = require('jsonwebtoken');
const request = require('superagent');

const defaults = require('./config/default-config');
const packageJson = require('./package.json');

function updateQRContentWithApiEndpoint(qrContent, endpoint) {
  return {
    ...qrContent,
    u: `${divaConfig.irmaApiServerUrl}${endpoint}/${qrContent.u}`,
  };
}

function attributeToContent(attribute, attributeLabel) {
  return [{
    label: attributeLabel,
    attributes: [attribute],
  }];
}

/**
 * Start a new IRMA session: request session token, save it and return it
 * @param {String} endpoint URL endpoint of IRMA Api Server (without base url)
 * @param {String} jwtBody Encoded JWT containing issue, disclosure or signing request
 * @returns {Promise<json>} Session token and content of IRMA QR
 */
function requestIrmaSession(endpoint, jwtBody) {
  return request
    .post(divaConfig.irmaApiServerUrl + endpoint)
    .type('text/plain')
    .send(jwtBody)
    .then((result) => {
      divaState.setIrmaEntry(result.body.u, 'PENDING'); // Async
      return {
        irmaSessionId: result.body.u,
        qrContent: updateQRContentWithApiEndpoint(result.body, endpoint),
      };
    })
    .catch((error) => {
      // TODO: make this a typed error
      const e = new Error(`Error starting IRMA session: ${error.message}`);
      throw e;
    });
}

/**
 * Generate a content array that can be used in either disclosure of signature request
 * @param {String/Object} attribute identitifier to be disclosed or content object
 * @param {String/Undefined} attributeLabel label used with attribute identifier
 * @returns {Array<Object>} list of attribute disjunctions
 */
function generateDisclosureContent(attributes, attributeLabel) {
  return (typeof attributes === 'string' && typeof attributeLabel === 'string')
    ? attributeToContent(attributes, attributeLabel)
    : attributes;
}

/**
 * Generate a content array that can be used in either disclosure of signature request
 * @param {String/Object} attribute identitifier to be disclosed or content object
 * @param {String/Undefined} attributeLabel label used with attribute identifier
 * @param {String}(Optional) divaSessionId Optional session id,
 *                           used to store irma proof in diva session
 * @returns {Array<Object>} list of attribute disjunctions
 */
function startDisclosureSession(
  attributes,
  attributeLabel,
  divaSessionId,
) {
  const content = generateDisclosureContent(attributes, attributeLabel);

  const sprequest = {
    data: divaSessionId,
    validity: 60,
    timeout: 600,
    request: {
      content,
    },
  };

  const jwtOptions = divaConfig.jwtDisclosureRequestOptions;

  const signedVerificationRequestJwt = jwt.sign(
    { sprequest },
    divaConfig.apiKey,
    jwtOptions,
  );

  return requestIrmaSession(divaConfig.verificationEndpoint, signedVerificationRequestJwt);
}

function startSignatureSession(
  attributes,
  attributeLabel,
  message,
) {
  const content = generateDisclosureContent(attributes, attributeLabel);

  const absrequest = {
    validity: 60,
    timeout: 600,
    request: {
      message,
      messageType: 'STRING',
      content,
    },
  };

  const jwtOptions = divaConfig.jwtSignatureRequestOptions;

  const signedSignatureRequestJwt = jwt.sign(
    { absrequest },
    divaConfig.apiKey,
    jwtOptions,
  );

  return requestIrmaSession(divaConfig.signatureEndpoint, signedSignatureRequestJwt);
}

/**
 * Start an issuance session.
 * @param {*} credentials Array of the credentials to be issued. See
 * https://credentials.github.io/protocols/irma-protocol/#issuing for the format. Note that if
 * the validity of the credentials is not a multiple of 60*60*24*7 = 604800, the API server may
 * reject the issuance request, or it may accept it but floor it, depending on its configuration.
 * @returns {Promise<json>} Session token and content of IRMA QR
 */
function startIssueSession(credentials, attributes, attributeLabel) {
  const disclose = (attributes !== undefined)
    ? generateDisclosureContent(attributes, attributeLabel)
    : null;

  const iprequest = {
    validity: 600,
    timeout: 600,
    request: {
      credentials,
      disclose,
    },
  };
  const jwtOptions = divaConfig.jwtIssueRequestOptions;

  const signedIssueRequestJwt = jwt.sign(
    { iprequest },
    divaConfig.apiKey,
    jwtOptions,
  );

  return requestIrmaSession(divaConfig.issueEndpoint, signedIssueRequestJwt);
}

/**
 * Decode and verify JWT verify token from api server and check validity/signature
 * @function verifyIrmaJwt
 * @param {string} token JWT string
 * @param {object} jwtOptions JWT verification options
 * @returns {Promise<json>} decoded IRMA JWT token from api server
 */
function verifyIrmaApiServerJwt(token, jwtOptions) {
  const key = divaConfig.irmaApiServerPublicKey;
  return BPromise.try(() => jwt.verify(token, key, jwtOptions));
}

function completeDisclosureSession(irmaSessionId, token) {
  return verifyIrmaApiServerJwt(token, divaConfig.jwtIrmaApiServerVerifyOptions)
    .then((disclosureProofResult) => {
      divaState.setIrmaEntry(irmaSessionId, 'COMPLETED'); // Async
      return { disclosureProofResult, proofStatus: disclosureProofResult.status };
    });
}

function completeSignatureSession(irmaSessionId, token) {
  return verifyIrmaApiServerJwt(token, divaConfig.jwtIrmaApiServerSignatureOptions)
    .then((signatureResult) => {
      divaState.setIrmaEntry(irmaSessionId, 'COMPLETED'); // Async
      const { attributes, message, status } = signatureResult;
      return { jwt: token, attributes, message, proofStatus: status };
    });
}

function getDisclosureProofFromApiServer(irmaSessionId) {
  return request
    .get(`${divaConfig.irmaApiServerUrl}${divaConfig.verificationEndpoint}/${irmaSessionId}/getproof`)
    .then(result => result.text)
    .then(proof => completeDisclosureSession(irmaSessionId, proof));
}

function getSignatureFromApiServer(irmaSessionId) {
  return request
    .get(`${divaConfig.irmaApiServerUrl}${divaConfig.signatureEndpoint}/${irmaSessionId}/getsignature`)
    .then(result => result.text)
    .then(signature => completeSignatureSession(irmaSessionId, signature));
}

function getIrmaEndpoint(irmaSessionType) {
  switch (irmaSessionType) {
    case 'ISSUE':
      return divaConfig.issueEndpoint;
    case 'DISCLOSE':
      return divaConfig.verificationEndpoint;
    case 'SIGN':
      return divaConfig.signatureEndpoint;
    default: {
      const e = new Error(`Invalid irmaSessionType: ${irmaSessionType}`);
      throw e;
    }
  }
}

function getIrmaServerStatus(irmaEndpoint, irmaSessionId) {
  return request
    .get(`${divaConfig.irmaApiServerUrl}${irmaEndpoint}/${irmaSessionId}/status`)
    .type('text/plain')
    .then(result => result.body)
    .catch(() => { // eslint-disable-line arrow-body-style
      // The IRMA api server returns an error on expired sessions.
      // For now we treat all errors as non-existing irma disclosure sessions.
      return 'NOT_FOUND';
    });
}

function abortIrmaSession(irmaSessionId, serverStatus) {
  divaState.setIrmaEntry(irmaSessionId, 'ABORTED'); // Async
  return {
    irmaSessionStatus: 'ABORTED',
    serverStatus,
  };
}

function completeIrmaSession(irmaSessionType, irmaSessionId) {
  const completeStatus = {
    irmaSessionStatus: 'COMPLETED',
    serverStatus: 'DONE',
  };

  switch (irmaSessionType) {
    case 'DISCLOSE':
      return getDisclosureProofFromApiServer(irmaSessionId)
        .then(result => ({
          ...result,
          ...completeStatus,
        }));
    case 'SIGN':
      return getSignatureFromApiServer(irmaSessionId)
        .then(result => ({
          ...result,
          ...completeStatus,
        }));
    case 'ISSUE':
      // Issuance sessions are easier than disclosure or signing sessions,
      // as we don't have to retrieve a proof or signature at the end of the session.
      return completeStatus;
    default: {
      const e = new Error(`Invalid irmaSessionType: ${irmaSessionType}`);
      throw e;
    }
  }
}

function getIrmaStatus(irmaSessionType, irmaSessionId) {
  const irmaEndpoint = getIrmaEndpoint(irmaSessionType);
  const irmaSessionStatusPromise = divaState.getIrmaEntry(irmaSessionId);
  const irmaServerStatusPromise = getIrmaServerStatus(irmaEndpoint, irmaSessionId);

  return BPromise
    .all([
      irmaSessionStatusPromise,
      irmaServerStatusPromise,
    ])
    .spread((irmaSessionStatus, serverStatus) => {
      if (serverStatus === 'DONE') {
        return completeIrmaSession(irmaSessionType, irmaSessionId);
      }

      // This is for when we poll again
      if (irmaSessionStatus === 'COMPLETED') {
        return { irmaSessionStatus, serverStatus };
      }

      if (serverStatus === 'CANCELLED' || serverStatus === 'NOT_FOUND') {
        return abortIrmaSession(irmaSessionId, serverStatus);
      }

      // Pending
      return { irmaSessionStatus, serverStatus };
    });
}

function version() {
  return packageJson.version;
}

function init(options) {
  divaConfig = {
    ...defaults,
    ...options,
  };

  divaState = divaStateModule.init(divaConfig);
}

/**
* Module exports.
* @public
*/
module.exports = init;
module.exports.init = init;
module.exports.startDisclosureSession = startDisclosureSession;
module.exports.startSignatureSession = startSignatureSession;
module.exports.startIssueSession = startIssueSession;
module.exports.getIrmaStatus = getIrmaStatus;
module.exports.version = version;