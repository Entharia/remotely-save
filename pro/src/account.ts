import { nanoid } from "nanoid";
import { base64url } from "rfc4648";
import {
  OAUTH2_FORCE_EXPIRE_MILLISECONDS,
  type RemotelySavePluginSettings,
} from "../../src/baseTypes";
import {
  COMMAND_CALLBACK_PRO,
  type FeatureInfo,
  PRO_CLIENT_ID,
  type PRO_FEATURE_TYPE,
  PRO_WEBSITE,
  type ProConfig,
} from "./baseTypesPro";

const site = PRO_WEBSITE;
console.debug(`remotelysave official website: ${site}`);

export const DEFAULT_PRO_CONFIG: ProConfig = {
  accessToken: "",
  accessTokenExpiresInMs: 0,
  accessTokenExpiresAtTimeMs: 0,
  refreshToken: "",
  enabledProFeatures: [],
  email: "",
};

/**
 * https://datatracker.ietf.org/doc/html/rfc7636
 * dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
 * => E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
 * @param x
 * @returns BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))
 */
async function codeVerifier2CodeChallenge(x: string) {
  if (x === undefined || x === "") {
    return "";
  }
  try {
    return base64url.stringify(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x))
      ),
      {
        pad: false,
      }
    );
  } catch (e) {
    return "";
  }
}

export const generateAuthUrlAndCodeVerifierChallenge = async (
  hasCallback: boolean
) => {
  const appKey = PRO_CLIENT_ID ?? "cli-"; // hard-code
  const codeVerifier = nanoid(128);
  const codeChallenge = await codeVerifier2CodeChallenge(codeVerifier);
  let authUrl = `${site}/oauth2/authorize?response_type=code&client_id=${appKey}&token_access_type=offline&code_challenge_method=S256&code_challenge=${codeChallenge}&scope=pro.list.read`;
  if (hasCallback) {
    authUrl += `&redirect_uri=obsidian://${COMMAND_CALLBACK_PRO}`;
  }
  return {
    authUrl,
    codeVerifier,
    codeChallenge,
  };
};

export const sendAuthReq = async (
  verifier: string,
  authCode: string,
  errorCallBack: any
) => {
  const appKey = PRO_CLIENT_ID ?? "cli-"; // hard-code
  try {
    const k = {
      code: authCode,
      grant_type: "authorization_code",
      code_verifier: verifier,
      client_id: appKey,
      // redirect_uri: `obsidian://${COMMAND_CALLBACK_PRO}`,
      scope: "pro.list.read",
    };
    // console.debug(k);
    const resp1 = await fetch(`${site}/api/v1/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams(k),
    });
    const resp2 = await resp1.json();
    return resp2;
  } catch (e) {
    console.error(e);
    if (errorCallBack !== undefined) {
      await errorCallBack(e);
    }
  }
};

export const sendRefreshTokenReq = async (refreshToken: string) => {
  const appKey = PRO_CLIENT_ID ?? "cli-"; // hard-code
  try {
    console.info("start auto getting refreshed Remotely Save access token.");
    const resp1 = await fetch(`${site}/api/v1/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: appKey,
        scope: "pro.list.read",
      }),
    });
    const resp2: AuthResError | AuthResSucc = await resp1.json();
    console.info("finish auto getting refreshed Remotely Save access token.");
    return resp2;
  } catch (e) {
    console.error(e);
    throw e;
  }
};

interface AuthResError {
  error: "invalid_request";
}

interface AuthResSucc {
  error: undefined; // needed for typescript
  refresh_token?: string;
  access_token: string;
  expires_in: number;
}

export const setConfigBySuccessfullAuthInplace = async (
  config: ProConfig,
  authRes: AuthResError | AuthResSucc,
  saveUpdatedConfigFunc: () => Promise<any> | undefined
) => {
  if (authRes.error !== undefined) {
    throw Error(`you should not save the setting for ${authRes.error}`);
  }

  config.accessToken = authRes.access_token;
  config.accessTokenExpiresAtTimeMs =
    Date.now() + authRes.expires_in * 1000 - 5 * 60 * 1000;
  config.accessTokenExpiresInMs = authRes.expires_in * 1000;
  config.refreshToken = authRes.refresh_token || config.refreshToken;

  // manually set it expired after 80 days;
  config.credentialsShouldBeDeletedAtTimeMs =
    Date.now() + OAUTH2_FORCE_EXPIRE_MILLISECONDS;

  await saveUpdatedConfigFunc?.();

  console.info(
    "finish updating local info of Remotely Save official website token"
  );
};

export const getAccessToken = async (
  config: ProConfig,
  saveUpdatedConfigFunc: () => Promise<any> | undefined
) => {
  const ts = Date.now();
  if (
    config.accessToken !== undefined &&
    config.accessToken !== "" &&
    config.accessTokenExpiresAtTimeMs > ts &&
    (config.credentialsShouldBeDeletedAtTimeMs ?? ts + 1000 * 1000) > ts
  ) {
    return config.accessToken;
  }

  console.debug(
    `currently, accessToken=${config.accessToken}, accessTokenExpiresAtTimeMs=${
      config.accessTokenExpiresAtTimeMs
    }, credentialsShouldBeDeletedAtTimeMs=${
      config.credentialsShouldBeDeletedAtTimeMs
    },comp1=${config.accessTokenExpiresAtTimeMs > ts}, comp2=${
      (config.credentialsShouldBeDeletedAtTimeMs ?? ts + 1000 * 1000) > ts
    }`
  );

  // try to get it again??
  const res = await sendRefreshTokenReq(config.refreshToken ?? "refresh-");
  await setConfigBySuccessfullAuthInplace(config, res, saveUpdatedConfigFunc);

  if (res.error !== undefined) {
    throw Error("cannot update accessToken");
  }
  return res.access_token;
};

export const getAndSaveProFeatures = async (
  config: ProConfig,
  pluginVersion: string,
  saveUpdatedConfigFunc: () => Promise<any> | undefined
) => {
  const access = await getAccessToken(config, saveUpdatedConfigFunc);

  const resp1 = await fetch(`${site}/api/v1/pro/list`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${access}`,
      "REMOTELYSAVE-API-Plugin-Ver": pluginVersion,
    },
  });
  const rsp2: {
    proFeatures: FeatureInfo[];
  } = await resp1.json();

  config.enabledProFeatures = rsp2.proFeatures;
  await saveUpdatedConfigFunc?.();
  return rsp2;
};

export const getAndSaveProEmail = async (
  config: ProConfig,
  pluginVersion: string,
  saveUpdatedConfigFunc: () => Promise<any> | undefined
) => {
  const access = await getAccessToken(config, saveUpdatedConfigFunc);

  const resp1 = await fetch(`${site}/api/v1/profile/list`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${access}`,
      "REMOTELYSAVE-API-Plugin-Ver": pluginVersion,
    },
  });
  const rsp2: {
    email: string;
  } = await resp1.json();

  config.email = rsp2.email;
  await saveUpdatedConfigFunc?.();
  return rsp2;
};

/**
 * If the check doesn't pass, the function should throw the error
 * @returns
 */
export const checkProRunnableAndFixInplace = async (
  featuresToCheck: PRO_FEATURE_TYPE[],
  config: RemotelySavePluginSettings,
  pluginVersion: string,
  saveUpdatedConfigFunc: () => Promise<any> | undefined
): Promise<true> => {
  console.debug(`checkProRunnableAndFixInplace`);

  // many checks if status is valid

  // no account
  if (config.pro === undefined || config.pro.refreshToken === undefined) {
    throw Error(`you need to "connect" to your account to use PRO features`);
  }

  // every features should have at most 40 days expiration dates
  // and if the time has expired, we also check
  const msIn40Days = 1000 * 60 * 60 * 24 * 40;
  for (const f of config.pro.enabledProFeatures) {
    const tooFarInTheFuture = f.expireAtTimeMs >= Date.now() + msIn40Days;
    const alreadyExpired = f.expireAtTimeMs <= Date.now();
    if (tooFarInTheFuture || alreadyExpired) {
      console.info(
        `the pro feature is too far in the future and has expired, check again.`
      );
      await getAndSaveProFeatures(
        config.pro,
        pluginVersion,
        saveUpdatedConfigFunc
      );
      break;
    }
  }

  const errorMsgs = [];

  // check for the features
  if (featuresToCheck.contains("feature-smart_conflict")) {
    if (config.conflictAction === "smart_conflict") {
      if (
        config.pro.enabledProFeatures.filter(
          (x) => x.featureName === "feature-smart_conflict"
        ).length === 1
      ) {
        // good to go
      } else {
        errorMsgs.push(
          `You're trying to use "smart conflict" PRO feature but you haven't subscribe to it.`
        );
      }
    } else {
      // good to go
    }
  }

  if (featuresToCheck.contains("feature-google_drive")) {
    console.debug(
      `checking "feature-google_drive", serviceType=${config.serviceType}`
    );
    console.debug(
      `enabledProFeatures=${JSON.stringify(config.pro.enabledProFeatures)}`
    );

    if (config.serviceType === "googledrive") {
      if (
        config.pro.enabledProFeatures.filter(
          (x) => x.featureName === "feature-google_drive"
        ).length === 1
      ) {
        // good to go
      } else {
        errorMsgs.push(
          `You're trying to use "sync with Google Drive" PRO feature but you haven't subscribe to it.`
        );
      }
    } else {
      // good to go
    }
  }

  if (errorMsgs.length !== 0) {
    throw Error(errorMsgs.join("\n\n"));
  }

  return true;
};
