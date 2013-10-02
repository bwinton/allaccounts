/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


var NewDocUser = {

  addNewDocument: function(msgData) {
    var outerEntry = {
      __proto__: null,
      type: "domcreated",
      "inner-id": msgData.inner,
      "original-url": msgData.url
    };

    if ("x-frameElement.src" in msgData) {
      outerEntry["frameSrc"] = msgData["x-frameElement.src"];
    }
    if ("parentUrl" in msgData) {
      outerEntry.parent = msgData.parentUrl;
    }
    if ("openerUrl" in msgData) {
      outerEntry.opener = msgData.openerUrl;
    }

    var outerData = WinMap.addToOuterHistory(outerEntry, msgData.outer, msgData.parentOuter);

    // a location can be about:blank or "" at DOMWindowCreated. The real url will be known later.
    // https://bugzilla.mozilla.org/show_bug.cgi?id=696416#c1
    PendingUsersLogins.check(msgData, outerData, "domcreated");

    var innerObj = WinMap.addInner(msgData);

    var isUndefined = (msgData.url.length === 0) || (msgData.url === "about:blank");
    if (isUndefined) {
      // we don't know yet if it is a logged in doc, so we need to customized it.
      // pode ser a logged in doc or anon.
      innerObj.pending_login = true; // URL is unknown, we cannot define docuser. afaik, it will be same as parent.
      outerEntry["x-doc-customized"] = true;
      return true;
    }

    var docUser = WinMap.findUser(msgData.uri, WinMap.getTopInnerId(msgData.inner)); // TODO reuse it from req/resp
    if (docUser !== null) {
      // logged in tld
      innerObj.docUserObj = docUser; // used by assets/iframes
      outerEntry.x_login = docUser;
    } else {
      // anon tld: inherit it from a parent
      docUser = WinMap.getNextSavedUser(msgData.parentInner);
    }

    if (docUser === null) {
      return false; // anon tab (docUser=null or NewAccount) => don't customize
    }

    outerEntry["x-doc-customized"] = true;
    return true;
  },


  addDocumentRequest: function(msgData, channel) {
    var isTop = WinMap.isTabId(msgData.parentInner);
    var tldPrev = isTop ? CrossTldLogin.getPrevDocTld(msgData.outer) : null; // should be called before addToOuterHistory

    var entry = {
      __proto__: null,
      type: "request-doc", // "request"
      visibleInnerId: msgData.visibleInner, // "previous" inner document
      url:  channel.URI.spec // TODO inutil?
    };

    var outerData = WinMap.addToOuterHistory(entry, msgData.outer);

    PendingUsersLogins.check(msgData, outerData, "request");

    var topInnerId;
    var docUser;
    if (WinMap.isTabId(msgData.parentInner)) {
      // topInnerId is not valid, it doesn't exist (yet)
      // channel is the new top document (or a download/redir, it is undefined)
      topInnerId = WinMap.TopWindowFlag;
      docUser = WinMap.findUser(channel.URI, topInnerId, msgData.outer);
    } else {
      topInnerId = WinMap.getTopInnerId(msgData.visibleInner);
      docUser = WinMap.findUser(channel.URI, topInnerId);
    }

    if (docUser === null) {
      // anon request: inherit it from a parent
      docUser = WinMap.getNextSavedUser(msgData.parentInner);
    }


    if (isTop && (docUser === null)) {
      // BUG docUser from a logged in iframe never will be != null
      docUser = CrossTldLogin.parse(tldPrev, channel.URI, msgData.outer, topInnerId);
      if (docUser !== null) {
        entry["x-tld-login"] = true;
      }
    }

    if (docUser !== null) {
      entry.reqDocUserObj = docUser; // used by response
    }
    return docUser;
  },


  // getLoginForDocumentResponse
  // currentInnerId (possibly) is going to be replaced by a new document
  addDocumentResponse: function(channel, currentInnerId, outerId) {
    var stat = channel.responseStatus;
    var entry = {
      __proto__:   null,
      type:        "response-doc",
      http_status: stat,
      contentType: channel.contentType,
      visibleInnerId: currentInnerId,
      url:            channel.URI.spec
    };
    if (stat !== 200) {
      // 301, 302, 303?
      try {
        var locat = channel.getResponseHeader("location");
        entry.x_redir = locat;
      } catch (ex) {
      }
    }

    WinMap.addToOuterHistory(entry, outerId);

    // should fetch login from request, because it could be a not logged in iframe
    // (which should inherit login from parent)
    var log = this._findDocRequest(currentInnerId, outerId);
    console.assert(log !== null, "reponse without a request");
    var docUser = "reqDocUserObj" in log ? log.reqDocUserObj : null;
    if (docUser !== null) {
      entry.x_login_obj = docUser; // for debug
    }
    return docUser;
  },


  _findDocRequest: function(innerId, outerId) {
    var outerDataLog = WinMap.getOuterEntry(outerId).outerHistory;
    for (var idx = outerDataLog.length - 1; idx > -1; idx--) {
      var req = outerDataLog[idx];
      if (req.type === "request-doc") {
        if (req.visibleInnerId === innerId) {
          return req;
        }
      }
    }
    return null;
  },


  viewSourceRequest: function(sourceWin, uri) { // sourceWin = viewSource.xul
    var chromeWin = UIUtils.getTopLevelWindow(sourceWin);
    if (chromeWin && chromeWin.opener) {
      if (UIUtils.isMainWindow(chromeWin.opener)) {
        var selTab = UIUtils.getSelectedTab(chromeWin.opener);
        return WinMap.findUser(uri, getCurrentTopInnerId(selTab), getIdFromTab(selTab));
      }
    }
    // BUG null for anon iframes (we would need to know its parent). find focused frame?
    console.log("viewSourceRequest null", sourceWin, uri);
    return null;
  }

};



var WinMap = { // stores all current outer/inner windows
   TopWindowFlag: -1,

  _outer: Object.create(null),
  _inner: Object.create(null),
  _remove: true, // for debug


  removeOuter: function(id) {
    if (this._remove) {
      delete this._outer[id];
    } else {
      if (this._outer[id]) {
        this._outer[id]["x-deleted"] = true;
      }
    }
  },


  removeInner: function(id) {
    if (this._remove) {
      // _inner[id] may not exist (not a content window).
      delete this._inner[id]; // it will keep references in _outer
    } else {
      if (this._inner[id]) {
        this._inner[id]["x-deleted"] = true;
      }
    }
  },


  _addWindow: function(win) { // called recursively by _update for all documents in a tab
    var parentOuterId;
    var parentInnerId;
    if (isTopWindow(win)) {
      parentOuterId = WinMap.TopWindowFlag;
      parentInnerId = WinMap.TopWindowFlag;
    } else {
      var parent = getDOMUtils(win.parent);
      parentOuterId = parent.outerWindowID;
      parentInnerId = parent.currentInnerWindowID;
    }

    var utils = getDOMUtils(win);
    var outerId = utils.outerWindowID;
    var innerId = utils.currentInnerWindowID;

    if (outerId in WinMap._outer === false) {
      WinMap.addToOuterHistory({
        __proto__: null,
        type: "enable/update"
      }, outerId, parentOuterId);
    }

    if (innerId in WinMap._inner === false) {
      WinMap.addInner({
        url: win.location.href,
        inner: innerId,
        outer: outerId,
        parentInner:parentInnerId
      });
    }
  },


  _update: function() {
    function forEachWindow(fn, win) {
      fn(win);
      for (var idx = win.length - 1; idx > -1; idx--) {
        forEachWindow(fn, win[idx]);
      }
    }

    var enumWin = UIUtils.getWindowEnumerator();
    while (enumWin.hasMoreElements()) {
      var tabList = UIUtils.getTabList(enumWin.getNext());
      for (var idx = tabList.length - 1; idx > -1; idx--) {
        forEachWindow(WinMap._addWindow, tabList[idx].linkedBrowser.contentWindow);
      }
    }
  },


  getOuterEntry: function(id) {
    console.assert(typeof id === "number", "getOuterEntry invalid param", id);
    if (id in this._outer) {
      return this._outer[id];
    }
    this._update();
    console.assert(id in this._outer, "getOuterEntry - outerId not found", id);
    return this._outer[id];
  },


  getInnerEntry: function(id) {
    console.assert(typeof id === "number", "getInnerEntry invalid param", id);
    if (id in this._inner) {
      return this._inner[id];
    }
    this._update();
    console.assert(id in this._inner, "getInnerEntry - innerId not found", id);
    return this._inner[id];
  },


  addInner: function(msgData) {
    var innerObj = {
      __proto__: null,
      "url": msgData.url,
      "outerId": msgData.outer,
      "parentInnerId": msgData.parentInner
    };

    // all inner windons should be preserved to allow a page from bfcache to use its original login
    console.assert((msgData.inner in this._inner) === false, "WinMap.addInner", msgData.inner);
    this._inner[msgData.inner] = innerObj;
    return innerObj;
  },


  loginSubmitted: function(win, data, docUser) {
    var entry = {
      __proto__: null,
      type:      "pw-submit",
      submitted: data,
      tld: getTldFromHost(win.location.hostname)
    };
    var outerId = getDOMUtils(win).outerWindowID;
    WinMap.addToOuterHistory(entry, outerId);
    if (docUser !== null) {
      UserChange.add(docUser, outerId);
    }
  },


  addToOuterHistory: function(newHistObj, outerId, parentId) {
    var outerData;
    if (outerId in this._outer) {
      outerData = this._outer[outerId];
      outerData["x-history-length"]++;
    } else {
      console.assert(typeof parentId !== "undefined", "missing parentId");
      outerData = {
        __proto__: null,
        parentOuter: parentId, // TODO parentId
        outerHistory: []
      };
      this._outer[outerId] = outerData;
      outerData["x-history-length"] = 1;
    }
    this._pushHistory(newHistObj, outerData.outerHistory);
    return outerData;
  },


  _pushHistory: function(entry, outerHistory) {
    if (outerHistory.length > 30) {
      var delQty = outerHistory.length - 10;
      outerHistory.splice(0, delQty, entry);
    } else {
      outerHistory.push(entry);
    }
  },


  isFrameId: function(parentId) { // outer/inner
    return parentId !== WinMap.TopWindowFlag;
  },


  isTabId: function(parentId) {
    return parentId === WinMap.TopWindowFlag;
  },


  isInvalidTopInnerId: function(innerId) {
    return innerId === WinMap.TopWindowFlag;
  },


  getTopOuterIdFromInnerId: function(innerId) {
    return this._inner[this.getTopInnerId(innerId)].outerId;
  },


  getTopInnerId: function(innerId) {
    console.assert(typeof innerId === "number", "getTopInnerId invalid param", innerId, typeof innerId);
    var all = this._inner;
    if ((innerId in all) === false) {
      this._update();
    }
    console.assert(innerId in all, "getTopInnerId not found", innerId);
    var win = all[innerId];
    if (!win) console.trace(win);
    while (WinMap.isFrameId(win.parentInnerId)) {
      innerId = win.parentInnerId;
      win = all[innerId];
    }
    return innerId;
  },


  getTabId: function(outerId) { // TODO findTabIdtab id = outer id from a top window
    console.assert(typeof outerId === "number", "getTabId invalid param", outerId);
    var all = this._outer;
    if ((outerId in all) === false) {
      this._update();
    }
    console.assert(outerId in all, "getTabId not found", outerId);
    var win = all[outerId];
    while (WinMap.isFrameId(win.parentOuter)) {
      outerId = win.parentOuter;
      win = all[outerId];
    }
    return outerId;
  },


  findUser: function(uriDoc, topInnerId, tabId) { // TODO only tld is necessary
    var tld = getTldFromUri(uriDoc);
    if (tld === null) {
      return null;
    }

    // check if this top document (or its elements) has previous requests to tld
    var userId;
    if (WinMap.isInvalidTopInnerId(topInnerId)) {
      // assume uriDoc as a top document
      console.assert(typeof tabId !== "undefined", "topInnerId invalid; tabId not defined");
      userId = UserState.getTabDefaultFirstPartyUser(tld, tabId);
    } else {
      var topData = WinMap.getInnerEntry(topInnerId);
      var tldFirstParty = getTldFromUri(Services.io.newURI(topData.url, null, null));
      if (tldFirstParty === tld) {
        userId = UserState.getTabDefaultFirstPartyUser(tld, topData.outerId);
      } else {
        userId = UserState.getTabDefaultThirdPartyUser(tld, topInnerId);
      }
    }

    if (userId === null) {
      // is the first time tld is used in this tab?
      userId = LoginDB.getDefaultUser(StringEncoding.encode(tld)); // 1st/3rd-party
    }

    return userId === null ? null
                           : new DocumentUser(userId, tld, topInnerId);
  },


  getNextSavedUser: function(innerId) {
    var entry;
    while (innerId !== WinMap.TopWindowFlag) {
      entry = this.getInnerEntry(innerId);
      console.assert(("pending_login" in entry) === false, "pending_login in getNextSavedUser", innerId, entry);
      if ("docUserObj" in entry) {
        return entry.docUserObj;
      }
      innerId = entry.parentInnerId;
    }
    return null;
  },


  // called by request/response: <img>, <script>, <style>, XHR... (but not <iframe>)
  getUserForAssetUri: function(innerId, realDocUrl, resUri) {
    // parent window docUser
    var docUser = this.getSavedUser(innerId, realDocUrl);
    if (docUser !== null) {
      return docUser;
    }

    // resUri could be a logged in tld (different from anonymous innerId)
    var topInnerId = WinMap.getTopInnerId(innerId);
    var assetUser = this.findUser(resUri, topInnerId);
    if (assetUser === null) {
      return null;
    }

    // fake a docUser
    var tld = getTldFromUri(Services.io.newURI(realDocUrl, null, null));
    if (tld === null) {
      // "about:"
      tld = getTldForUnsupportedScheme(Services.io.newURI(realDocUrl, null, null));
    }
    return new DocumentUser(null, tld, topInnerId);
  },


  getSavedUser: function(innerId, realDocUrl) {
    // TODO realDocUrl and entry.url should share the hostname
    var entry = this.getInnerEntry(innerId);
    if ("docUserObj" in entry) {
      return entry.docUserObj; // identity used by document
    }

    if ("pending_login" in entry) {
      console.assert(realDocUrl.length > 0, "getSavedUser empty");
      PendingUsersLogins.fixUserForInnerEntry(innerId, realDocUrl);
      if ("docUserObj" in entry) {
        return entry.docUserObj; // identity used by document
      }
    }

    return this.getNextSavedUser(entry.parentInnerId);
  },


  findUserForAboutBlank: function(innerId) { // JS popups/iframes?
    console.trace("findUserForAboutBlank", innerId);
    var inheritOpener = false;
    var inheritParent = false;

    var obj = this.getInnerEntry(innerId);
    var isTop = this.isTabId(obj.parentInnerId);
    if (isTop) {
      inheritOpener = true; // is realDocUrl an js top doc? copy login from opener
    } else {
      inheritParent = true; // is realDocUrl an js iframe? copy login from parent
    }

    if (inheritOpener) {
      var outerData = this.getOuterEntry(obj.outerId);
      if ("openerInnerId" in outerData) {
        var openerObj = this.getInnerEntry(outerData.openerInnerId);
        console.assert(openerObj.url !== "about:blank", "findUserForAboutBlank openerObj.url !== about:blank", openerObj.url);
        if ("docUserObj" in openerObj) {
          obj["x-inherited-opener"] = openerObj.url;
          return openerObj.docUserObj;
        }
      }
    } else if (inheritParent) {
      // innerId is an iframe with an anon url
      // we do not inherit users for top docs. however, we inhreit all default users from opener tab.
      var parentObj = this.getInnerEntry(obj.parentInnerId);
      console.assert(("pending_login" in parentObj) === false, "pending_login in parentInnerObj");
      if ("docUserObj" in parentObj) {
        obj["x-inherited-parent"] = parentObj.url;
        return parentObj.docUserObj;
      }
    }

    return null;
  },


  restoreTabDefaultUsers: function(tab) {
    if (tab.hasAttribute("multifox-tab-logins") === false) {
      return;
    }
    console.log("restoreDefaultLogins", tab.getAttribute("multifox-tab-logins"));

    var tabLogins;
    try {
      // TODO delay until tab is actually loaded (@ findUser?)
      tabLogins = JSON.parse(tab.getAttribute("multifox-tab-logins"));
    } catch (ex) {
      console.error(ex, "restoreTabDefaultUsers - buggy json", tab.getAttribute("multifox-tab-logins"));
      return;
    }

    if (("firstParty" in tabLogins) === false) {
      return;
    }

    var logins = tabLogins.firstParty;
    var tabId = getIdFromTab(tab);
    var obj;
    var userId;
    for (var tld in logins) {
      obj = logins[tld];
      userId = new UserId(obj.encodedUser, obj.encodedTld);
      UserState.setTabDefaultFirstParty(tld, tabId, userId);
    }
  },


  setTabAsNewAccount: function(tab) { // used by moveTabToDefault
    var topInnerId = getCurrentTopInnerId(tab);
    var topData = WinMap.getInnerEntry(topInnerId);
    console.assert("docUserObj" in topData, "setTabAsNewAccount docUser missing", topInnerId, topData);
    var docUser = topData.docUserObj;
    var user = docUser.user.toNewAccount();
    var tabId = this.getTopOuterIdFromInnerId(topInnerId);
    UserState.setTabDefaultFirstParty(docUser.ownerTld, tabId, user);
    return new DocumentUser(user, docUser.ownerTld, topInnerId);
  }

};



var DebugWinMap = {

  toString: function() {
    var usedInners = [];
    var usedOuters = [];
    var output = [];
    var intId;

    for (var id in WinMap._outer) {
      intId = parseInt(id, 10);
      if (WinMap.isTabId(WinMap.getOuterEntry(intId).parentOuter)) {
        this._debugOuter(intId, output, "", usedOuters, usedInners);
      }
    }

    for (var id in WinMap._outer) {
      intId = parseInt(id, 10);
      if (usedOuters.indexOf(intId) === -1) {
        output.unshift("*** outer not displayed " + intId, "---");
      }
    }

    for (var id in WinMap._inner) {
      intId = parseInt(id, 10);
      if (usedInners.indexOf(intId) === -1) {
        output.unshift("*** inner not displayed " + intId, "---");
      }
    }

    return output.join("\n");
  },


  _debugOuter: function(intOuterId, output, padding, usedOuters, usedInners) {
    var win = Services.wm.getOuterWindowWithId(intOuterId);

    // removed outer window?
    var currentInner = (win === null) || (win.location === null) ? -1 : getDOMUtils(win).currentInnerWindowID;
    var ok = false;

    for (var id in WinMap._inner) {
      var obj = WinMap._inner[id];
      if (obj.outerId !== intOuterId) {
        continue;
      }
      ok = true;
      var innerId = parseInt(id, 10);
      usedInners.push(innerId);
      var s = padding;
      s += "x-deleted"        in obj ? "-" : "*";
      s += "x-doc-customized" in obj ? "x" : "*";
      s += "pending_login"    in obj ? "?" : "*";

      s += " " + intOuterId + "[" + innerId + "] ";
      if ("docUserObj" in obj) {
        var docUser = obj.docUserObj;
        s += "{" + docUser.user.plainName + "/" + docUser.user.plainTld + "}  ";
      }
      s += obj.url.substr(0, 140);
      if (obj.url.length === 0) {
        s += "<url empty>";
      }
      if (currentInner === -1) {
        s += " <outer removed>";
      } else {
        if (currentInner === innerId) {
          if (win.location.href !== obj.url) {
            s += " - actual URL: " + win.location.href.substr(0, 140);
          }
        } else {
          s += " <not visible>";
        }
      }
      output.push(s);
    }
    if (ok === false) {
      output.unshift("*** outer without an innerId=" + innerId + " obj.outerId=" + obj.outerId + " intOuterId=" + intOuterId, "---");
    }

    usedOuters.push(intOuterId);
    for (var id in WinMap._outer) {
      var intId = parseInt(id, 10);
      if (WinMap.getOuterEntry(intId).parentOuter === intOuterId) {
        this._debugOuter(intId, output, padding + "        ", usedOuters, usedInners);
      }
    }
  }

};



var PendingUsersLogins = {

  // called by request/domcreated
  check: function(msgData, outerData, origin) {
    this._fillOpener(msgData, outerData, origin); // TODO needed only for new outer wins

    if (WinMap.isTabId(msgData.parentInner)) {
      // top:
      // _fillOpener (@request/domcreate) already copyed default logins to this new tab/popup.
      if ("openerInnerId" in outerData) {
        var openerObj = WinMap.getInnerEntry(outerData.openerInnerId); // BUG openerInnerId may not be available anymore
        if ("pending_login" in openerObj) {
          this.fixUserForInnerEntry(outerData.openerInnerId, outerData.openerUrl); // opener
        }
        console.assert(openerObj.url !== "about:blank", "PendingUsersLogins openerObj.url !== about:blank", openerObj.url);
      }

    } else {
      // frame: update parent info
      var parentObj = WinMap.getInnerEntry(msgData.parentInner);
      if ("pending_login" in parentObj) {
        this.fixUserForInnerEntry(msgData.parentInner, msgData.parentUrl);
      }
    }
  },


  _fillOpener: function(msgData, outerData, src) { // TODO still necessary?
    if (("openerOuter" in msgData) === false) {
      return;
    }

    if ("x-opener-order" in outerData) {
      outerData["x-opener-order"] += " " + src;
    } else {
      outerData["x-opener-order"] = src;
    }
    if ("opener-logins-migrated" in outerData) {
      return;
    }

    console.assert(WinMap.isTabId(msgData.parentOuter), "BUG has iframe an opener? maybe, target=nome_iframe");
    if ("openerOuterId" in outerData) {
      console.assert(outerData.openerOuterId === msgData.openerOuter, "outerData.openerOuterId !== msgData.openerOuter");
      console.assert(outerData.openerInnerId === msgData.openerInner, "outerData.openerInnerId !== msgData.openerInner");
    } else {
      outerData.openerInnerId = msgData.openerInner; // TODO opener: {innerId,...}
      outerData.openerOuterId = msgData.openerOuter;
      outerData.openerUrl     = msgData.openerUrl;
    }

    outerData["opener-logins-migrated"] = outerData.openerOuterId;

    var openerTabId = WinMap.getTabId(outerData.openerOuterId);
    var targetTabId = WinMap.getTabId(msgData.outer);
    this._copyLogins(targetTabId, openerTabId);
  },


  _copyLogins: function(targetTabId, sourceTabId) {
    console.assert(targetTabId !== sourceTabId, "_copyLogins same tab", sourceTabId);
    var sourceTabData = WinMap.getOuterEntry(sourceTabId);
    if (("tabLogins" in sourceTabData) === false) {
      return; // nothing to copy
    }

    var targetTabData = WinMap.getOuterEntry(targetTabId);
    if (("tabLogins" in targetTabData) === false) {
      targetTabData.tabLogins = {firstParty: Object.create(null)};
    }

    var targetLogins = targetTabData.tabLogins.firstParty;
    var openerLogins = sourceTabData.tabLogins.firstParty;

    // copy defaults logins to (new?) tab
    for (var tld in openerLogins) {
      // do not overwrite existing logins
      if ((tld in targetLogins) === false) {
        console.log("_copyLogins", tld, openerLogins[tld]);
        targetLogins[tld] = openerLogins[tld];
      }
    }
  },


  // used by check and getSavedUser
  fixUserForInnerEntry: function(innerId, realDocUrl) {
    var obj = WinMap.getInnerEntry(innerId);
    console.assert("pending_login" in obj, "pending_login fixUserForInnerEntry");
    var docUser = null;

    if (realDocUrl === "about:blank") {
      docUser = WinMap.findUserForAboutBlank(innerId);
    } else {
      console.assert(realDocUrl.length > 0, "realDocUrl empty");
      var uri = Services.io.newURI(realDocUrl, null, null); // TODO remove uri workaround
      docUser = WinMap.findUser(uri, WinMap.getTopInnerId(innerId));
    }


    var entry = {
      __proto__: null,
      type:     "fixed-url",
      inner_id: innerId,
      old_url:  obj.url,
      new_url:  realDocUrl
    };
    WinMap.addToOuterHistory(entry, obj.outerId);


    // current doc url and original can be different. eg:
    // https://mail.google.com/mail/#inbox
    // https://mail.google.com/mail/#spam
    delete obj.pending_login;
    obj.url = realDocUrl;

    if (docUser !== null) {
      obj.docUserObj = docUser; // TODO uncustomize if docUser=null
    }

    var isTop = WinMap.isTabId(obj.parentInnerId);
    var tabId = WinMap.getTabId(obj.outerId);
    updateUIAsync(findTabById(tabId), isTop);
  }

};
