exports = module.exports = function() {
  var async = require('async');
  var utils = require('./common/utils');
  var nodeUtil = require('util');
  var config = require('./config.json');
  var auth = require('./common/auth');
  var SshClient = require('ssh2').Client;
  var digitalOcean = require('./common/digitalocean').Api(auth.getDigitalOceanToken(), config.testMode);

  var selectedLibraryKey;
  var droplets = [];
  var nonChurnNodeBounds = {
    lowerBound: 0,
    upperBound: 0
  };
  var churnFrequency = 0;

  var getChurnFrequency = function(callback) {
    var onUserInput = function(frequency) {
      if (isNaN(frequency)) {
        console.log('Enter a valid number');
        return getChurnFrequency();
      }
      churnFrequency = frequency;
      callback();
    };
    utils.postQuestion('Enter the churn interval in seconds', onUserInput);
  };

  var GetDropletStatus = function(droplet) {
    this.run = function(callback) {
      executeCommandOnDroplet(droplet, 'ls Node.log', function(err) {
        callback(null, err ? false : true);
      });
    };
    return this.run;
  };

  var executeCommandOnDroplet = function(droplet, cmd, callback) {
    var Handler = function(sshOptions) {
      this.run = function(cb) {
        var conn = new SshClient();
        var errorMessage = 'SSH Execution Failed for: ' + sshOptions.host;
        conn.on('ready', function() {
          conn.exec(cmd, function(err, stream) {
            if (err) {
              return cb(errorMessage);
            }
            stream.on('close', function(code) {
              conn.end();
              return cb(code === 0 ? null : errorMessage);
            });
          });
        }).on('error', function() {
          return cb(errorMessage);
        }).connect(sshOptions);
      };
      return this.run;
    };
    var sshOptions = {
      /*jshint camelcase: false */
      // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
      host: droplet.networks.v4[0].ip_address,
      // jscs:enable requireCamelCaseOrUpperCaseIdentifiers
      /*jshint camelcase: true */
      username: config.dropletUser,
      password: auth.getDropletUserPassword(),
      readyTimeout: 99999
    };
    new Handler(sshOptions, cmd)(function(err) {
      if (!err) {
        return callback(null);
      }
      callback(err);
    });
  };

  var getNonChurnNodes = function(callback) {
    var invalidRange = function() {
      console.log('Enter a valid input');
      getNonChurnNodes();
    };
    var onUserInput = function(range) {
      if (!range) {
        return invalidRange();
      }
      range = range.split('-');
      if (range.length !== 2) {
        return invalidRange();
      }
      for (var i in range) {
        if (range[i]) {
          if (isNaN(range[i])) {
            return invalidRange();
          }
          range[i] = parseInt(range[i]);
          if (!(range[i] > 0 && range[i] <= droplets.length)) {
            return invalidRange();
          }
        }
      }
      nonChurnNodeBounds.lowerBound = range[0];
      nonChurnNodeBounds.upperBound = range[1];
      callback();
    };
    utils.postQuestion('Enter the non-churn nodes range between 1-' + droplets.length, onUserInput);
  };

  var getDroplets = function(callback) {
    digitalOcean.getDropletList(function(err, list) {
      if (err) {
        callback(err);
        return;
      }
      var userName = auth.getUserName();
      var pattern = userName + '-' + selectedLibraryKey;
      for (var i in list) {
        if (list[i].name.indexOf(pattern) === 0) {
          droplets.push(list[i]);
        }
      }
      if (droplets.length === 0) {
        var msg = 'No droplets found for user %s for the selected library %s. Setup a network and try again';
        return callback(nodeUtil.format(msg, auth.getUserName(), selectedLibraryKey));
      }
      callback();
    });
  };

  var startChurning = function() {
    var runningNodesCount = 0;
    var nodesStarted = 0;
    var nodesStopped = 0;
    var dropletsToChurn =
        droplets.slice(0, nonChurnNodeBounds.lowerBound - 1).concat(droplets.slice(nonChurnNodeBounds.upperBound));

    var getRandomIndex = function() {
      return Math.floor(Math.random() * dropletsToChurn.length);
    };

    var getNodeIndexFromName = function(name) {
      return name.split(/[- ]+/).pop();
    };

    var StartNode = function(droplet) {
      var cmd = 'tmux new-session -d \". ~/.bash_profile;teamocil settings\"';
      var nodeIndex = getNodeIndexFromName(droplet.name);
      executeCommandOnDroplet(droplet, cmd, function(err) {
        if (err) {
          /*jshint camelcase: false */
          // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
          return console.log('Failed to start: Node %s - %s', nodeIndex, droplet.networks.v4[0].ip_address);
          // jscs:enable requireCamelCaseOrUpperCaseIdentifiers
          /*jshint camelcase: true */
        }
        droplet.isRunning = true;
        runningNodesCount++;
        nodesStarted++;
        console.log('Started: Node %s \t Current Network Size: %s', nodeIndex, runningNodesCount);
        console.log('Completed Churn Event: %s \t Nodes Started %s \t Nodes Stopped %s',
            nodesStarted + nodesStopped, nodesStarted, nodesStopped);
      });
    };

    var StopNode = function(droplet) {
      var cmd = 'tmux kill-session; mv ~/Node.log Node_`date +%Y_%m_%d_%H:%M:%S`.log || true' ;
      var nodeIndex = getNodeIndexFromName(droplet.name);
      executeCommandOnDroplet(droplet, cmd, function(err) {
        if (err) {
          /*jshint camelcase: false */
          // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
          return console.log('Failed to stop: Node %s - %s', nodeIndex, droplet.networks.v4[0].ip_address);
          // jscs:enable requireCamelCaseOrUpperCaseIdentifiers
          /*jshint camelcase: true */
        }
        droplet.isRunning = false;
        runningNodesCount--;
        nodesStopped++;
        console.log('Stopped: Node %s \t Current Network Size: %s', nodeIndex, runningNodesCount);
        console.log('Completed Churn Event: %s \t Nodes Started %s \t Nodes Stopped %s',
            nodesStarted + nodesStopped, nodesStarted, nodesStopped);
      });
    };

    var churn = function() {
      var droplet = dropletsToChurn[getRandomIndex()];
      if (droplet.isRunning) {
        new StopNode(droplet);
      } else {
        new StartNode(droplet);
      }
    };

    console.log('Calculating current network size\n');
    var tasks = [];
    for (var i in droplets) {
      if (droplets[i]) {
        tasks.push(new GetDropletStatus(droplets[i]));
      }
    }

    async.parallel(tasks, function(err, res) {
      if (err) {
        throw err;
      }
      /*jshint forin: false */
      for (var i in res) {
        /*jshint forin: true */
        // TODO remove the jshint lookfunc error instead of suppressing it
        /*jshint loopfunc: true */
        dropletsToChurn.some(function(el) {
          /*jshint loopfunc: false */
          if (el.name.indexOf(droplets[i].name) === 0) {
            el.isRunning = res[i];
            return true;
          }
        });
        if (res[i]) {
          runningNodesCount++;
        }
      }

      console.log('Current Network Size: %s\n\nStarting Churn...\n', runningNodesCount);
      setInterval(churn, churnFrequency * 1000);
    });
  };

  var prepare = function(selectedOption) {
    var i = 0;
    /*jshint forin: false */
    for (var key in config.libraries) {
      /*jshint forin: true */
      i++;
      if (i === selectedOption) {
        selectedLibraryKey = key;
        break;
      }
    }
    var waterfallTasks = [];
    waterfallTasks.push(
        getDroplets,
        getNonChurnNodes,
        getChurnFrequency
    );

    async.waterfall(waterfallTasks, function(err) {
      if (err) {
        return console.error(err);
      }
      startChurning();
    });
  };

  var onOptionSelected = function(option) {
    var keys = [];
    option = parseInt(option);
    var optionNotValid = function() {
      console.log('Invalid option selected');
      showOptions();
    };
    for (var key in config.libraries) {
      if (key) {
        keys.push(key);
      }
    }
    if (isNaN(option) || option < 0 || option > keys.length) {
      optionNotValid();
    } else {
      prepare(option);
    }
  };

  var showOptions = function() {
    var libOptions = '\n--------- \n';
    var i = 1;
    var isExample;
    for (var key in config.libraries) {
      if (config.libraries[key]) {
        isExample = config.libraries[key].hasOwnProperty('example');
        libOptions += (i + '. ' + key.replace(/-.*/g, '') + ' ' + (isExample ? 'Example' : 'Binary') +
        ' - ' + (isExample ? config.libraries[key].example : config.libraries[key].binary) + '\n');
        i++;
      }
    }

    utils.postQuestion('Please choose the entry for which the network will be churned: ' +
    libOptions, onOptionSelected);
  };

  showOptions();
};
