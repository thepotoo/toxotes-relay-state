/* The toxotes node to handle setting relay states.

A database connection and a mqtt connection are required.  We use the standard node red configuration nodes for each.

This node must be passed a payload
msg.payload = "0";  // 1, 0, true, false, on, off

Optionally, a friendly name can be set.  This will change all things with the friendly name
msg.friendly_name = "My relay";

Setting a friendly name in the node config will override the friendly name in the message.

A unique_id can be sent via message, typically this is relay_ followed by the 6 digit ESP chip id:
msg.unique_id = "relay_ABCDEF";

// Optional parameters:
msg.retain = false;
msg.qos = 2;
msg.manual = false; // Send as a manual command to override all other relay-state nodes.  This should only be used in flows triggered by real world objects you'll interact with, like buttons
*/
module.exports = function(RED) {
    "use strict";
    function toxotesRelayState(config) {
        RED.nodes.createNode(this,config);
        this.topic = config.topic;
        this.retain = config.retain;
        this.broker = config.broker;
        this.brokerConn = RED.nodes.getNode(this.broker);
        this.friendlyName = config.toxotesRelayFriendlyName;
        this.retain = config.retain;
        this.overrideAsManual = config.overrideAsManual;
        this.mydb = config.mydb;
        this.mydbConfig = RED.nodes.getNode(this.mydb);
        var node = this;

        if (node.mydbConfig) {
            node.mydbConfig.connect();
            if (node.brokerConn) {
                node.on("input",function(msg,send,done) {
                    var error = false;
                    if (!node.mydbConfig.connected) {
                        error = "Database not yet connected";
                    }
                    if (!error) {
                        // Validate payload
                        if (msg.payload === true || msg.payload === "1" || msg.payload === "true") {
                            msg.payload = 1;
                        }
                        if (msg.payload === false || msg.payload === "0" || msg.payload === "false") {
                            msg.payload = 0;
                        }
                        if (msg.payload !== 0 && msg.payload !== 1 && msg.payload.toLowerCase() !== "on" && msg.payload.toLowerCase() !== "off") {
                            error = "Invalid payload, use 1, 0, on, off";
                        }
                    }
                    // Validate other mqtt settings.  From node-red's 10-mqtt.js file
                    if (!msg.hasOwnProperty('qos')) {
                        msg.qos = 2;
                    } else {
                        msg.qos = parseInt(msg.qos);
                    }
                    if ((msg.qos !== 0) && (msg.qos !== 1) && (msg.qos !== 2)) {
                        msg.qos = 2;
                    }
                    msg.retain = node.retain || msg.retain || false;
                    msg.manual = node.overrideAsManual || msg.manual || false;
                    msg.retain = ((msg.retain === true) || (msg.retain === "true")) || false;
                    if (!error) {
                        if (node.friendlyName !== "") {
                            //node.warn(`setting friendly name to ${node.friendlyName}`);
                            msg.friendly_name = node.friendlyName;
                        }
                        if (!msg.hasOwnProperty('unique_id') && !msg.friendly_name) {
                            error = "msg.friendly_name must be set";
                        }
                    }
                    if (!error) {
                        findThingsInDB(msg,node,done);
                    } else {
                        node.status({fill:"red",shape:"ring",text: "Error: " + error});
                    }
                });
                node.brokerConn.register(node);
                node.on('close', function(done) {
                    node.brokerConn.deregister(node,done);
                    node.mydbConfig.removeAllListeners();
                });
            } else {
                node.error(RED._("mqtt.errors.missing-config"));
            }
        } else {
            node.error("MySQL database not configured");
        }
    }
    RED.nodes.registerType("Change relay",toxotesRelayState);
}

function findThingsInDB(msg, node, done) {
    msg.topic = `SELECT
    friendly_name,
    unique_id,
    host_id,
    under_manual_control,
    manual_control_for,
    current_value,
    automatic_command
    FROM things `;
    if (msg.hasOwnProperty('unique_id')) {
        msg.topic += `WHERE unique_id = '${msg.unique_id}'`;
    } else {
        msg.topic += `WHERE friendly_name = '${msg.friendly_name}'`;
    }
    var result = [];
    node.mydbConfig.connection.query(msg.topic, result, (err, rows) => {
        if (err) {
            node.error(err,msg);
        } else {
            if (rows === undefined || rows.length === 0) {
                if (msg.hasOwnProperty('unique_id')) {
                    error = `Unique ID ${msg.unique_id} not found`
                } else {
                    error = `Thing ${msg.friendly_name} not found`;
                }
                node.status({fill:"red",shape:"ring",text: error});
                node.warn(error);
            } else {
                result = rows;
                setState(msg, node, result, done);
            }
        }
    });
}

function updateSQL(msg, node, done) {
    var result = [];
    node.mydbConfig.connection.query(msg.topic, result, (err, rows) => {
        if (err) {
            node.error(err,msg);
        }
        done();
    });
}

function setState(msg, node, result, done) {
    var totalThings = result.length;
    var sql = "";
    var lastFriendlyName = ""; // To display as the status, if setting state via unique_id
    for (var i=0; i < totalThings; i++) {
        msg.topic = "cmnd/" + result[i].host_id + "/POWER";  // Fixme - this should not be hard coded
        lastFriendlyName = result[i].friendly_name;
        if (msg.manual) {
            // Sending this as a manual command
            var now = new Date().getTime();
            var manualControlEnds = now + result[i].manual_control_for * 60 * 1000;  // Minutes to ms
            // When manual control ends, revert to the current state
            if (result[i].automatic_command === null) {
                result[i].automatic_command = result[i].current_value;
            }
            // Update automatic command even though this is a manual command
            // Necessary in case there is no automatic control at all for this thing
            sql += `UPDATE
                    things
                    SET
                    under_manual_control = '${manualControlEnds}',
                    automatic_command = '${result[i].automatic_command}'
                    WHERE unique_id = '${result[i].unique_id}'
                    ;`;
            node.brokerConn.publish(msg, done);  // send the message
        } else {
            // All automatic commands should update the automatic command field
            // And show the AUTO button in the dashboard
            sql += `UPDATE
            things
            SET
            automatic_command = '${msg.payload}',
            automatic_retain = '${msg.retain}',
            automatic_qos = '${msg.qos}',
            show_automatic_control = '1'
            WHERE unique_id = '${result[i].unique_id}'
            ;`;
            if (result[i].under_manual_control !== null) {
                // currently under manual control
            } else {
                node.brokerConn.publish(msg, done);  // send the message
            }
        }  // End automatic commands
    }
    // Set the node status
    var state = msg.payload;
    // If friendly name was not set in the node, display the actual device that was last changed as the status
    if (node.friendlyName === "") {  //(msg.hasOwnProperty('unique_id') || (
        state = `${msg.payload} (${lastFriendlyName})`;
    }
    if (msg.payload === "1" || msg.payload.toLowerCase() == "on") {
        node.status({fill:"green",shape:"dot",text: state});
    } else if (msg.payload === "0" || msg.payload.toLowerCase() == "off") {
        node.status({fill:"red",shape:"dot",text: state});
    } else {
        node.status({text: state});
    }
    // update database with all states
    msg.topic = sql;
    updateSQL(msg, node, done);
}