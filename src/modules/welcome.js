/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";


function welcomePopup(doc) {
  var panel = doc.getElementById("${BASE_DOM_ID}-popup");
  if (panel) {
    //bug
    panel.hidePopup();
    return null; // panel is now invalid
  }

  panel = doc.getElementById("mainPopupSet").appendChild(doc.createElement("panel"));
  panel.setAttribute("id", "${BASE_DOM_ID}-popup");
  panel.setAttribute("type", "arrow");
  panel.setAttribute("noautohide", true);
  panel.addEventListener("popuphidden", function(evt) {
    panel.parentNode.removeChild(panel);
    initIconNormal(doc);
  }, false);

  var container = panel.appendChild(doc.createElement("vbox"));
  container.style.width = "50ch";
  container.style.margin = "-16px";
  container.style.padding = "0px";
  appendContent(container, panel);
  return panel;
}


function appendContent(container, panel) {
  var contents;
  var doc = container.ownerDocument;
  var desc;
  var header;
  var item;
  var footer;

  // Getting Started

  contents = container.appendChild(doc.createElement("vbox"));
  contents.style.padding = "16px";

  header = contents.appendChild(doc.createElement("label"));
  header.value = util.getTextFrom("welcome.properties", "welcome.p1.h");
  header.className = "header";
  header.style.margin = "0";
  header.style.fontSize = "1.5em";

  desc = contents.appendChild(doc.createElement("description"));
  desc.style.margin = "1ch 0 0 0";
  desc.appendChild(doc.createTextNode(util.getTextFrom("welcome.properties", "welcome.p2")));

  header = contents.appendChild(doc.createElement("label"));
  header.value = util.getTextFrom("welcome.properties", "welcome.p3.h");
  header.className = "header";
  header.style.margin = "1ch 0 0 0";
  header.style.fontSize = "1.5em";

  item = contents.appendChild(doc.createElement("div"));
  item.appendChild(doc.createTextNode(util.getTextFrom("welcome.properties", "welcome.p4.li1")));
  item.style.display = "block";
  item.style.margin = "1ch 0 0 0";

  item = contents.appendChild(doc.createElement("div"));
  item.appendChild(doc.createTextNode(util.getTextFrom("welcome.properties", "welcome.p4.li2")));
  item.style.display = "block";

  item = contents.appendChild(doc.createElement("div"));
  item.appendChild(doc.createTextNode(util.getTextFrom("welcome.properties", "welcome.p4.li3")));
  item.style.display = "block";

  footer = container.appendChild(doc.createElement("div"));
  footer.style.display = "flex";
  footer.style.flexFlow = "row";
  footer.style.backgroundColor = "rgba(24, 25, 26, 0.07)";
  footer.style.borderTop = "1px solid rgba(24, 25, 26, 0.14)";
  footer.style.padding = "16px";
  footer.style.justifyContent = "space-around";
  footer.minHeight = "30px";

  item = footer.appendChild(doc.createElement("toolbarbutton"));
  item.setAttribute("label", "Dismiss Tutorial");
  item = footer.appendChild(doc.createElement("toolbarbutton"));
  item.setAttribute("label", "Keep Tutorial");
}
