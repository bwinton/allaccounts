/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


var NetworkObserver = {

  start: function() {
    var obs = Services.obs;
    obs.addObserver(this._request, "http-on-modify-request", false);
    obs.addObserver(this._response, "http-on-examine-response", false);
  },


  stop: function() {
    var obs = Services.obs;
    obs.removeObserver(this._request, "http-on-modify-request");
    obs.removeObserver(this._response, "http-on-examine-response");
  },


  _request: {
    // nsIObserver
    observe: function HttpListeners_request(subject, topic, data) {
      var httpChannel = subject.QueryInterface(Ci.nsIHttpChannel);
      var ctx = getLoadContext(httpChannel)

      if ((ctx === null) || ctx.usePrivateBrowsing) {
        // safebrowsing, http://wpad/wpad.dat
        return;
      }

      var docUser;
      var isWin = isWindowChannel(httpChannel);

      try{
        var win = ctx.associatedWindow;
      } catch (ex) {
        // background thumbnailing?
        // [nsIException: [Exception... "Component returned failure code: 0x8000ffff (NS_ERROR_UNEXPECTED)
        console.log("request exception", httpChannel.URI.spec);
        return;
      }


      var tab = UIUtils.getLinkedTab(win);
      if (tab !== null) {
        if (isWin) {
          // window/redir/download
          docUser = NewDocUser.addDocumentRequest(fillDocReqData(win), httpChannel);
        } else {
          // css/js/xhr...
          var winutils = getDOMUtils(win);
          docUser = WinMap.getUserForAssetUri(winutils.currentInnerWindowID, httpChannel.URI);
        }

      } else {
        var chromeWin = UIUtils.getTopLevelWindow(win);
        if (chromeWin && UIUtils.isSourceWindow(chromeWin)) {
          // view source window
          console.log("REQUEST - viewsource", httpChannel.URI);
          docUser = NewDocUser.viewSourceRequest(win, httpChannel.URI);
        } else {
          console.log("REQUEST - TAB NOT FOUND", httpChannel.URI, win);
          return; // tab not found: request from chrome (favicon, updates, <link rel="next"...)
        }
      }


      if (docUser === null) {
        // log to topData.thirdPartyUsers
        UserState.addRequest(httpChannel.URI, win, isWin, null);
        if ((docUser === null) && LoginDB.isLoggedIn(StringEncoding.encode(getTldFromHost(httpChannel.URI.host)))) {
          console.log("REQ ERR - login found but not used!", isWin, httpChannel.URI, win.location.href);
        }
        return; // send default cookies
      }


      // log to topData.thirdPartyUsers
      var userHost = docUser.getHost(httpChannel.URI.host);
      UserState.addRequest(httpChannel.URI, win, isWin, userHost.user);

      /*
      var myHeaders = HttpHeaders.fromRequest(httpChannel);
      if (myHeaders["authorization"] !== null) {
        // docUser + authorization = not supported
        enableErrorMsgLocal("authorization", win);
      }
      */

      var userUri = httpChannel.URI.clone();
      userUri.host = userHost.toJar();
      var cookie = Cookies.getCookie(false, userUri);
      httpChannel.setRequestHeader("Cookie", cookie, false);
    }
  },

  _response: {
    // nsIObserver
    observe: function HttpListeners_response(subject, topic, data) {
      var httpChannel = subject.QueryInterface(Ci.nsIHttpChannel);
      var ctx = getLoadContext(httpChannel)
      if ((ctx === null) || ctx.usePrivateBrowsing) {
        return;
      }

      try{
        var win = ctx.associatedWindow;
      } catch (ex) {
        // background thumbnailing?
        // [nsIException: [Exception... "Component returned failure code: 0x8000ffff (NS_ERROR_UNEXPECTED)
        console.log("response exception", httpChannel.URI.spec);
        return;
      }

      var tab = UIUtils.getLinkedTab(win);
      if (tab === null) {
        return;
      }

      var isWin = isWindowChannel(httpChannel);
      var winutils = getDOMUtils(win);

      var docUser;
      if (isWin) {
        // window/redir/download
        docUser = NewDocUser.addDocumentResponse(httpChannel,
                                                 winutils.currentInnerWindowID,
                                                 winutils.outerWindowID);
      } else {
        docUser = WinMap.getUserForAssetUri(winutils.currentInnerWindowID,
                                            httpChannel.URI);
      }


      if (docUser === null) {
        if ((docUser === null) && LoginDB.isLoggedIn(StringEncoding.encode(getTldFromHost(httpChannel.URI.host)))) {
          console.log("RESPONSE ERR - login found but not used!", isWin, httpChannel.URI, win.location.href);
        }
        return;
      }

      var myHeaders = HttpHeaders.fromResponse(httpChannel);

      var setCookies = myHeaders["set-cookie"];
      if (setCookies === null) {
        return;
      }

      if (myHeaders["www-authenticate"] !== null) {
        // docUser + www-authenticate = not supported
        enableErrorMsgLocal("www-authenticate", win);
      }

      // remove "Set-Cookie"
      httpChannel.setResponseHeader("Set-Cookie", null, false);

      Cookies.setCookie(docUser, httpChannel.URI, setCookies, false);
    }
  }
};




var HttpHeaders = {
  visitLoop: {
    values: null,
    visitHeader: function(name, value) {
      var n = name.toLowerCase();
      if (n in this.values) {
        this.values[n] = value;
      }
    }
  },

  /*
  fromRequest: function(request) {
    var nameValues = {
      //"cookie": null, //for debug only
      "authorization": null
    }
    this.visitLoop.values = nameValues;
    request.visitRequestHeaders(this.visitLoop);
    return nameValues;
  },
  */

  fromResponse: function(response) {
    var nameValues = {
      "set-cookie": null,
      "www-authenticate": null
    }
    this.visitLoop.values = nameValues;
    response.visitResponseHeaders(this.visitLoop);
    return nameValues;
  }
};


function fillDocReqData(win) {
  var utils = getDOMUtils(win);

  if (isTopWindow(win) === false) {
    console.assert(win.opener === null, "is an iframe supposed to have an opener?");
    var utilsParent = getDOMUtils(win.parent);
    return {
      __proto__ :  null,
      outer:       utils.outerWindowID,
      visibleInner:utils.currentInnerWindowID,
      parentOuter: utilsParent.outerWindowID,
      parentInner: utilsParent.currentInnerWindowID,
      parentUrl:   win.parent.location.href
    };
  }

  if (win.opener) {
    var msgData = {
      __proto__ :  null,
      outer:       utils.outerWindowID,
      visibleInner:utils.currentInnerWindowID,
      parentOuter: WinMap.TopWindowFlag,
      parentInner: WinMap.TopWindowFlag
    };
    var utilsOpener = getDOMUtils(win.opener);
    msgData.openerOuter = utilsOpener.outerWindowID;
    return msgData;
  }

  return {
    __proto__ :  null,
    outer:       utils.outerWindowID,
    visibleInner:utils.currentInnerWindowID,
    parentOuter: WinMap.TopWindowFlag,
    parentInner: WinMap.TopWindowFlag
  };
}


function isWindowChannel(channel) {
  return (channel.loadFlags & Ci.nsIChannel.LOAD_DOCUMENT_URI) !== 0;
}


function getLoadContext(channel) {
  if (channel.notificationCallbacks) {
    try {
      return channel
              .notificationCallbacks
              .getInterface(Ci.nsILoadContext);
    } catch (ex) {
      //console.trace("channel.notificationCallbacks " + "/" + channel.notificationCallbacks + "/" + channel.URI + "/" + ex);
    }
  }

  if (channel.loadGroup && channel.loadGroup.notificationCallbacks) {
    try {
      return channel
              .loadGroup
              .notificationCallbacks
              .getInterface(Ci.nsILoadContext);
    } catch (ex) {
      console.trace("channel.loadGroup " + channel.loadGroup + "/" + channel.URI.spec + "/" + ex);
    }
  }

  //var isChrome = context.associatedWindow instanceof Ci.nsIDOMChromeWindow;
  //return context.isContent ? context.associatedWindow : null;
  //console.log("LOAD CONTEXT FAIL " + channel.URI);
  return null; // e.g. <link rel=prefetch> <link rel=next> ...
}
