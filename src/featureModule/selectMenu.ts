import * as puppeteer from "puppeteer";
import { Logger } from "log4js";
import { MenuConfigObject, MenuItemObject } from "./config";
import { loginConfig } from "../prodConfig";
import { pushDuration } from "../pushGateway";
import { handleScreenShot } from "./util";
import { MENU_NAV_TIMEOUT } from "./config";

const AllMenuContainer = ".jazz-menu > *";
const SubMenuContainerSelector = '[role="menu"]';
const SubItemSelector = "[role='menuitem']";
const CustomerSettingSubItemSelector = "[aria-expanded='true']";
const TimeOutOption = {
  // waitUntil: ["domcontentloaded"],
  timeout: MENU_NAV_TIMEOUT * 1000,
};

var logger: Logger = null;
var currentTime: Date = new Date();

interface mainMenuObject {
  hasSubMenus: boolean;
  text: string;
  ele?: puppeteer.ElementHandle<Element>;
}

const gotoSubMenuPage = async (
  childConfig: MenuItemObject,
  currentMenu: puppeteer.ElementHandle<Element>,
  currentMenuText: string,
  page: puppeteer.Page,
  parentEle: puppeteer.ElementHandle<Element>,
  index: number
): Promise<void> => {
  try {
    if (index !== 0) {
      await parentEle.hover();
      await page.waitForSelector(SubMenuContainerSelector, TimeOutOption);

      if (childConfig.children) {
        currentMenu.hover();
      } else {
        logger.info(
          `[selectMenu/handleCheckUnitPage/gotoSubMenuPage]::click subMenu ${currentMenuText}`
        );
        await currentMenu.click();
      }
    } else {
      logger.info(
        `[selectMenu/handleCheckUnitPage/gotoSubMenuPage]::enter subMenu ${currentMenuText}`
      );
    }

    let newPage = page;
    var pageList = [];
    if (childConfig.outer) {
      await page.waitFor(2000);
      pageList = await page.browser().pages();
      if (pageList.length > 2) {
        logger.info(
          `[selectMenu/handleCheckUnitPage/gotoSubMenuPage]::browser has ${pageList.length} pages`
        );
        newPage = pageList[pageList.length - 1];
      }
    }
    await newPage.waitForSelector(childConfig.validClass, TimeOutOption);

    const duration = (Number(new Date()) - Number(currentTime)) / 1000;
    pushDuration(loginConfig.prodAlias, duration, `menu_${childConfig.key}`);
    // await handleScreenShot(
    //   currentTime,
    //   new Date(),
    //   `menu ${currentMenuText}_success`,
    //   getProdAlias(),
    //   page
    // );
    currentTime = new Date();

    logger.info(
      `[selectMenu/handleCheckUnitPage/gotoSubMenuPage]::menu ${currentMenuText} show`
    );

    if (pageList.length > 2) {
      logger.info(
        `[selectMenu/handleCheckUnitPage/gotoSubMenuPage]::close new page`
      );
      await newPage.close();
    }
  } catch (error) {
    // 捕获二级菜单错误
    logger.error(
      `[selectMenu/handleCheckUnitPage/gotoSubMenuPage]::menu ${currentMenuText} element[${childConfig.validClass}] was not found or not shown`
    );
    await handleScreenShot(
      currentTime,
      new Date(),
      `menu_${childConfig.key}`,
      page
    );
    throw new Error("select menu error");
  }
};

async function handleCheckUnitPage(
  menu: mainMenuObject,
  page: puppeteer.Page,
  config: MenuConfigObject,
  index: number
) {
  logger.info(
    `[selectMenu/handleCheckUnitPage]::menu ${menu.text} has ${
      menu.hasSubMenus ? "" : "no"
    } subMenus `
  );

  if (!menu.hasSubMenus) {
    // 无二级菜单
    if (index !== 0) {
      //第一个菜单不用再去操作
      await menu.ele.click();
    }

    let newPage = page;
    var pageList = [];

    if (config.outer) {
      await page.waitFor(2000);
      pageList = await page.browser().pages();
      if (pageList.length > 2) {
        logger.info(
          `[selectMenu/handleCheckUnitPage]::browser has ${pageList.length} pages`
        );
        newPage = pageList[pageList.length - 1];
      }
    }

    await newPage
      .waitForSelector(config.validClass, TimeOutOption)
      .catch((e: any) => {
        const ele = config;
        logger.error(
          `[selectMenu/handleCheckUnitPage]::menu ${ele.name} element[${ele.validClass}] was not found or not shown validClass`
        );
        handleScreenShot(currentTime, new Date(), `menu_${ele.key}`, page);
        logger.error(`page menu ${ele.name} was not found or not shown`);
        throw new Error("select menu error");
      });

    await handleScreenShot(currentTime, new Date(), `menu_${config.key}`, page);
    currentTime = new Date();
    logger.info(`[selectMenu/handleCheckUnitPage]::menu ${config.name} show`);

    if (pageList.length > 2) {
      logger.info(`[selectMenu/handleCheckUnitPage]::close new page`);
      await newPage.close();
    }
  } else {
    logger.info(
      `[selectMenu/handleCheckUnitPage]::menu ${menu.text} has submenu`
    );
    await menu.ele.hover();

    if (menu.text === "数据点配置" || menu.text === "层级配置") {
      await page.waitForSelector(CustomerSettingSubItemSelector);
    } else {
      await page.waitForSelector(SubMenuContainerSelector);
    }

    logger.info(
      `[selectMenu/handleCheckUnitPage]::menu ${menu.text} show sub menus`
    );

    const subItems = await page.$$(SubItemSelector);
    const subItemsText: Array<mainMenuObject> = await page.$$eval(
      SubItemSelector,
      (submenu) => {
        return [...submenu].map((item, idx) => {
          return {
            hasSubMenus: item.childElementCount !== 0,
            text: item.textContent,
          };
        });
      }
    );

    logger.info(
      `[selectMenu/handleCheckUnitPage]::menu ${menu.text}'s subItems:`,
      subItemsText
    );

    for (let idx in subItemsText) {
      //查找二级菜单子元素
      const childConfigGroup = config.children;
      const childConfig = childConfigGroup.find(
        (item: any) => item.name === subItemsText[idx].text
      );
      // 如果是配置过的项目
      if (childConfig) {
        console.log("childConfig=", childConfig);
        if (childConfig.children) {
          subItemsText[idx].ele = subItems[idx];
          await handleCheckUnitPage(
            subItemsText[idx],
            page,
            childConfig,
            Number(idx)
          );
        } else {
          await gotoSubMenuPage(
            childConfig,
            subItems[idx],
            subItemsText[idx].text,
            page,
            menu.ele,
            //第一个菜单的第一个子菜单不用再去操作
            index === 0 ? Number(idx) : 1
          );
        }
      }
    }
  }
}

export async function selectMenu(
  page: puppeteer.Page,
  monitoredMenuConfig: Array<MenuConfigObject>,
  sourceLogger: Logger
) {
  //录入数据菜单动态加载，所以延时1s等待加载
  await page.waitFor(2000);

  currentTime = new Date();
  logger = sourceLogger;
  logger.info("[selectMenu/selectMenu]::start");

  // 查找出所有线上的一级菜单名
  let mainMenus = await page.$$(AllMenuContainer);

  let mainMenuConfig: Array<mainMenuObject> = await page.$$eval(
    AllMenuContainer,
    (menus) => {
      return [...menus].map((item) => {
        return {
          hasSubMenus: item.childElementCount !== 0,
          text: item.textContent,
        };
      });
    }
  );

  logger.info("[selectMenu/selectMenu]::mainMenuConfig=", mainMenuConfig);

  for (let index in mainMenuConfig) {
    // 当前功能是否是需要监控的功能
    let currentMonitoredMenuConfig = monitoredMenuConfig.find(
      (item: MenuConfigObject) => item.name === mainMenuConfig[index].text
    );

    if (currentMonitoredMenuConfig) {
      if (
        currentMonitoredMenuConfig.children &&
        !mainMenuConfig[index].hasSubMenus
      ) {
        continue;
      }
      logger.info(
        "[selectMenu/selectMenu]::current menu is ",
        currentMonitoredMenuConfig.name
      );

      mainMenuConfig[index]["ele"] = mainMenus[index];
      await handleCheckUnitPage(
        mainMenuConfig[index],
        page,
        currentMonitoredMenuConfig,
        Number(index)
      );
    }
  }
}
