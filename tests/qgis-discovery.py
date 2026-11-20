import json
import time
from pathlib import Path
from uuid import uuid4

from qgis.core import Qgis, QgsApplication, QgsAuthMethodConfig, QgsOwsConnection, QgsSettings, QgsVectorLayer
from qgis.gui import QgsGui
from qgis.PyQt.QtCore import QEventLoop, QTimer
from qgis.PyQt.QtWidgets import QComboBox, QPushButton, QTreeView


def connect_and_list(widget):
    button = widget.findChild(QPushButton, "btnConnect")
    model = widget.findChild(QTreeView, "treeView").model()
    button.click()
    deadline = time.monotonic() + 7
    while time.monotonic() < deadline:
        loop = QEventLoop()
        QTimer.singleShot(100, loop.quit)
        loop.exec()
        if button.isEnabled() and model.rowCount():
            # The WFS source selector displays collection IDs in the Name column.
            return sorted(model.index(row, 1).data() for row in range(model.rowCount()))
    raise RuntimeError("QGIS did not finish loading the collection list.")


def run_discovery(fixture):
    auth = QgsApplication.authManager()
    if not auth.masterPasswordIsSet():
        raise RuntimeError("Unlock the QGIS Authentication Manager before running the test.")

    name = "GIS Platform test " + uuid4().hex
    key = "connections/ows/items/wfs/connections/items/" + name
    previous = QgsOwsConnection.selectedConnection("WFS")
    settings = QgsSettings()
    config = QgsAuthMethodConfig()
    config.setName(name)
    config.setMethod("APIHeader")
    config.setVersion(1)
    config.setConfig("Cookie", fixture["cookie"])
    widget = None
    try:
        settings.setValue(key + "/url", fixture["url"])
        provider = QgsGui.sourceSelectProviderRegistry().providerByName("WFS")
        widget = provider.createDataSourceWidget()
        combo = next(c for c in widget.findChildren(QComboBox) if c.findText(name) >= 0)
        combo.setCurrentIndex(combo.findText(name))
        before = connect_and_list(widget)

        if not auth.storeAuthenticationConfig(config):
            raise RuntimeError("Could not save the temporary QGIS authentication configuration.")
        settings.setValue(key + "/authcfg", config.id())
        widget.refresh()
        combo.setCurrentIndex(combo.findText(name))
        after = connect_and_list(widget)

        uri = QgsOwsConnection("WFS", name).uri()
        uri.setParam("typename", "private-places")
        layer = QgsVectorLayer(uri.uri(False), name, "oapif")
        if not layer.isValid():
            raise RuntimeError("QGIS could not open the private collection with the test connection.")
        return {"before": before, "after": after, "features": sum(1 for _ in layer.getFeatures()),
                "version": Qgis.QGIS_VERSION}
    finally:
        if widget is not None:
            widget.deleteLater()
        QgsOwsConnection.deleteConnection("WFS", name)
        QgsOwsConnection.setSelectedConnection("WFS", previous)
        if config.id():
            auth.removeAuthenticationConfig(config.id())


print(json.dumps(run_discovery(json.loads(Path(fixture_path).read_text(encoding="utf-8")))))
