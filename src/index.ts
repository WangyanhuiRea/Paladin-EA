import * as bodyParser from "body-parser";
import * as express from "express";
import { configure, getLogger } from "log4js";
import * as promClient from "prom-client";
import * as puppeteer from "puppeteer";
import logConfig from "./logConfig";
import notification from "./notification";
import * as config from "./prodConfig";
import { pushDuration, pushStatus, reset } from "./pushGateway";
import {
  cleanImage,
  isMaintaining,
  screenshot,
  upload,
  initOssClient,
} from "./util";
import checkMainFeatures from "./featureModule";
import login from "./login";

const LOG_LEVEL = process.env["LOG_LEVEL"] || "DEBUG";

configure(logConfig(LOG_LEVEL));

const logger = getLogger("index");
const endpoint = process.env["HARDCORE_OSS_ENDPOINT"];
const accessKeySecret = process.env["COMMON_ALIYUN_ACCESS_SECRET"];
const accessKeyId = process.env["COMMON_ALIYUN_ACCESS_ID"];
const bucket = process.env["OSS_BUCKET_DATA"];
const interval = process.env["PALADIN_EA_Interval"] || "2";

const NAV_TIMEOUT = parseInt(process.env["NAV_TIMEOUT"] || "15") * 1000;
const CLICK_TIMEOUT = parseInt(process.env["CLICK_TIMEOUT"] || "5") * 1000;

let envArgs: Array<string> = [
  "TROJAN_HOST",
  "LOG_LEVEL",
  "NODE_ENV",
  "HARDCORE_OSS_ENDPOINT",
  "OSS_BUCKET_DATA",
  "COMMON_ALIYUN_ACCESS_SECRET",
  "COMMON_ALIYUN_ACCESS_ID",
];

envArgs.forEach((item: string) => {
  let ret = false;
  let val = process.env[item];
  if (!val) {
    logger.fatal("env var %s missing", item);
    ret = true;
  } else {
    logger.debug("%s is %s", item, val);
  }
  if (ret) {
    process.exit(1);
  }
});

logger.debug(
  "proxy: %s, %s",
  process.env["HTTP_PROXY"],
  process.env["HTTPS_PROXY"]
);

initOssClient(endpoint, accessKeyId, accessKeySecret, bucket);

const app = express();
const port = 3000;
const register = promClient.register;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get("/metrics", (req, res) => {
  logger.info(`paladin-ea start metrics collection`);
  res.set("Content-Type", register.contentType);
  res.status(200).send(register.metrics());
  if (isEnd) {
    logger.info(`paladin-ea reset metrics`);
    reset();
  }
});

const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics({ timeout: 60 * 1000, prefix: "paladin_" });

app.get("/healthz", (req, res) => {
  logger.info("healthz");
  res.status(200).send("ok");
});

app.post("/maintain", (req, res) => {
  let { maintain } = req.body;
  logger.info("maintaining status change to : %d", maintain);
  if (maintain === 1) {
    process.env["IS_MAINTAINING"] = "1";
    reset();
  } else {
    process.env["IS_MAINTAINING"] = "0";
  }
  res.status(200).send("ok");
});

app.listen(port, () => {
  logger.info(`paladin app listening on port ${port}!`);
  start();
  setInterval(start, parseInt(interval) * 60 * 1000);
});

async function createPage(browser: puppeteer.Browser) {
  const page = await browser.newPage();
  // page.setCacheEnabled(false)
  page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36 Paladin"
  );
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.setRequestInterception(true);
  // page.on("requestfailed", (request) => {
  //   logger.debug("requestfailed: %s", request.url())
  // })
  page.on("response", (response) => {
    if (!response.ok() && response.status() >= 400) {
      logger.debug(
        "response maybe error: %s, %s",
        response.status(),
        response.url()
      );
    }
  });
  page.on("request", (req) => {
    let resourceType = req.resourceType();
    const headers = Object.assign({}, req.headers(), {
      "cache-control": "public", // remove "cache-control" header
      pragma: "public",
    });
    if (resourceType === "image") {
      req.abort();
    } else {
      req.continue({ headers });
      // req.continue();
    }
  });

  return page;
}

const navigationOption: puppeteer.NavigationOptions = {
  waitUntil: ["domcontentloaded"],
};
const timeoutOption = { timeout: CLICK_TIMEOUT };

let checkRoleList = "";
let lastAction = "";

async function run(page: puppeteer.Page, config: config.Config) {
  checkRoleList = `${config.codeName}-ui`;
  let startTime: any = new Date();
  let endTime: any = new Date();
  let duration: number = 0;
  let response = await page.goto(config.mainUri);
  // quote from official website
  // page.goto either throw or return a main resource response.
  // The only exceptions are navigation to about:blank or navigation to the
  // same URL with a different hash, which would succeed and return null
  if (response) {
    if (response.status() === 200) {
      logger.info("enter page: %s", response.url());
    } else {
      logger.error("fail to enter page: %s", config.mainUri);
      throw new Error(`enter page failed: ${response.url()}`);
    }
  }

  lastAction = "mainpage";
  let loginButton = await page.waitForSelector(
    config.loginButtonClass,
    timeoutOption
  );
  if (loginButton) {
    logger.info("login button shown");
    await screenshot(page, "mainpage");
    endTime = new Date();
    duration = (endTime - startTime) / 1000;
    pushDuration(config.prodAlias, duration, "mainpage_success");
  } else {
    logger.info("login button not shown, url is: %s", page.url());
    throw new Error("unknow error");
  }

  checkRoleList = `guard-ui,guard,classic`;
  startTime = new Date();
  let responses = await Promise.all([
    await page.click(config.loginButtonClass),
    await page.waitForNavigation(navigationOption),
    // await page.waitForNavigation(navigationOption)
  ]);
  responses.forEach((item: any) => {
    if (item && item.url) {
      logger.info("url change to %s", item.url());
    }
  });

  await login(config, page);

  await checkMainFeatures(config, page);
}

// uploadAndCleanImage()
// cleanImage()

async function getBrowser() {
  let args = [
    "--lang=zh-cn",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-accelerated-2d-canvas",
  ];
  logger.debug("SE_PROXY: %s", process.env["SE_PROXY"]);
  if (process.env["SE_PROXY"] === "1") {
    args.push("--proxy-server=101.231.121.17:80");
  }
  let browser = await puppeteer.launch({
    defaultViewport: {
      width: 1920,
      height: 1080,
    },
    ignoreHTTPSErrors: true,
    // devtools: true,
    // headless: false,
    args,
  });

  return browser;
}
let isEnd = false;
async function start() {
  if (isMaintaining()) {
    logger.info("it is maintaining, not start to collect");
    return;
  }
  logger.info("started");
  isEnd = false;
  try {
    cleanImage();
    await notification.syncLastStatus(config.loginConfig);
    const browser = await getBrowser();
    checkRoleList = "";
    const page = await createPage(browser);
    logger.info("page created for: %s", config.loginConfig.prodName);
    let startTime: any = new Date();
    try {
      await run(page, config.loginConfig);
      await page.close();
      let endTime: any = new Date();
      let duration: any = (endTime - startTime) / 1000;
      pushDuration(config.loginConfig.prodAlias, duration, "full");
      //pushStatus must be last one be called
      pushStatus(config.loginConfig.prodAlias, 0);
      notification.success(config.loginConfig.prodName);
    } catch (error) {
      logger.error(error);
      logger.error(page.url());
      //pushstatus must be last one be called
      pushStatus(config.loginConfig.prodAlias, 1);
      await screenshot(page, `error-before-${lastAction}`);
      await page.close();
      notification.error(config.loginConfig.prodName, error, checkRoleList);
    } finally {
      await upload(config.loginConfig.prodName);
      cleanImage();
      await browser.close();
      logger.info("browser closed");
    }

    await notification.pushLastStatus(config.loginConfig);
    isEnd = true;
  } catch (error) {
    logger.fatal("Unknown error: %s", error);
  }
}
