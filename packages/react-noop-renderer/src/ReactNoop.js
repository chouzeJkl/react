/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * This is a renderer of React that doesn't have a render target output.
 * It is useful to demonstrate the internals of the reconciler in isolation
 * and for testing semantics of reconciliation separate from the host
 * environment.
 */

import type {Fiber} from 'react-reconciler/src/ReactFiber';
import type {UpdateQueue} from 'react-reconciler/src/ReactFiberUpdateQueue';

// TODO: direct imports like some-package/src/* are bad. Fix me.
import ReactFiberInstrumentation from 'react-reconciler/src/ReactFiberInstrumentation';
import ReactFiberReconciler from 'react-reconciler';
import {enablePersistentReconciler} from 'shared/ReactFeatureFlags';
import * as ReactInstanceMap from 'shared/ReactInstanceMap';
import emptyObject from 'fbjs/lib/emptyObject';
import expect from 'expect';

const UPDATE_SIGNAL = {};

var scheduledCallback = null;

type Container = {rootID: string, children: Array<Instance | TextInstance>};
type Props = {prop: any, hidden?: boolean};
type Instance = {|
  type: string,
  id: number,
  children: Array<Instance | TextInstance>,
  prop: any,
|};
type TextInstance = {|text: string, id: number|};

var instanceCounter = 0;

var failInBeginPhase = false;

function appendChild(
  parentInstance: Instance | Container,
  child: Instance | TextInstance,
): void {
  const index = parentInstance.children.indexOf(child);
  if (index !== -1) {
    parentInstance.children.splice(index, 1);
  }
  parentInstance.children.push(child);
}

function insertBefore(
  parentInstance: Instance | Container,
  child: Instance | TextInstance,
  beforeChild: Instance | TextInstance,
): void {
  const index = parentInstance.children.indexOf(child);
  if (index !== -1) {
    parentInstance.children.splice(index, 1);
  }
  const beforeIndex = parentInstance.children.indexOf(beforeChild);
  if (beforeIndex === -1) {
    throw new Error('This child does not exist.');
  }
  parentInstance.children.splice(beforeIndex, 0, child);
}

function removeChild(
  parentInstance: Instance | Container,
  child: Instance | TextInstance,
): void {
  const index = parentInstance.children.indexOf(child);
  if (index === -1) {
    throw new Error('This child does not exist.');
  }
  parentInstance.children.splice(index, 1);
}

let elapsedTimeInMs = 0;

var SharedHostConfig = {
  getRootHostContext() {
    if (failInBeginPhase) {
      throw new Error('Error in host config.');
    }
    return emptyObject;
  },

  getChildHostContext() {
    return emptyObject;
  },

  getPublicInstance(instance) {
    return instance;
  },

  createInstance(type: string, props: Props): Instance {
    const inst = {
      id: instanceCounter++,
      type: type,
      children: [],
      prop: props.prop,
    };
    // Hide from unit tests
    Object.defineProperty(inst, 'id', {value: inst.id, enumerable: false});
    return inst;
  },

  appendInitialChild(
    parentInstance: Instance,
    child: Instance | TextInstance,
  ): void {
    parentInstance.children.push(child);
  },

  finalizeInitialChildren(
    domElement: Instance,
    type: string,
    props: Props,
  ): boolean {
    return false;
  },

  prepareUpdate(
    instance: Instance,
    type: string,
    oldProps: Props,
    newProps: Props,
  ): null | {} {
    return UPDATE_SIGNAL;
  },

  shouldSetTextContent(type: string, props: Props): boolean {
    return (
      typeof props.children === 'string' || typeof props.children === 'number'
    );
  },

  shouldDeprioritizeSubtree(type: string, props: Props): boolean {
    return !!props.hidden;
  },

  createTextInstance(
    text: string,
    rootContainerInstance: Container,
    hostContext: Object,
    internalInstanceHandle: Object,
  ): TextInstance {
    var inst = {text: text, id: instanceCounter++};
    // Hide from unit tests
    Object.defineProperty(inst, 'id', {value: inst.id, enumerable: false});
    return inst;
  },

  scheduleDeferredCallback(callback) {
    if (scheduledCallback) {
      throw new Error(
        'Scheduling a callback twice is excessive. Instead, keep track of ' +
          'whether the callback has already been scheduled.',
      );
    }
    scheduledCallback = callback;
    return 0;
  },

  cancelDeferredCallback() {
    if (scheduledCallback === null) {
      throw new Error('No callback is scheduled.');
    }
    scheduledCallback = null;
  },

  prepareForCommit(): void {},

  resetAfterCommit(): void {},

  now(): number {
    return elapsedTimeInMs;
  },
};

var NoopRenderer = ReactFiberReconciler({
  ...SharedHostConfig,
  mutation: {
    commitMount(instance: Instance, type: string, newProps: Props): void {
      // Noop
    },

    commitUpdate(
      instance: Instance,
      updatePayload: Object,
      type: string,
      oldProps: Props,
      newProps: Props,
    ): void {
      instance.prop = newProps.prop;
    },

    commitTextUpdate(
      textInstance: TextInstance,
      oldText: string,
      newText: string,
    ): void {
      textInstance.text = newText;
    },

    appendChild: appendChild,
    appendChildToContainer: appendChild,
    insertBefore: insertBefore,
    insertInContainerBefore: insertBefore,
    removeChild: removeChild,
    removeChildFromContainer: removeChild,

    resetTextContent(instance: Instance): void {},
  },
});

var PersistentNoopRenderer = enablePersistentReconciler
  ? ReactFiberReconciler({
      ...SharedHostConfig,
      persistence: {
        cloneInstance(
          instance: Instance,
          updatePayload: null | Object,
          type: string,
          oldProps: Props,
          newProps: Props,
          internalInstanceHandle: Object,
          keepChildren: boolean,
          recyclableInstance: null | Instance,
        ): Instance {
          const clone = {
            id: instance.id,
            type: type,
            children: keepChildren ? instance.children : [],
            prop: newProps.prop,
          };
          Object.defineProperty(clone, 'id', {
            value: clone.id,
            enumerable: false,
          });
          return clone;
        },

        createContainerChildSet(
          container: Container,
        ): Array<Instance | TextInstance> {
          return [];
        },

        appendChildToContainerChildSet(
          childSet: Array<Instance | TextInstance>,
          child: Instance | TextInstance,
        ): void {
          childSet.push(child);
        },

        finalizeContainerChildren(
          container: Container,
          newChildren: Array<Instance | TextInstance>,
        ): void {},

        replaceContainerChildren(
          container: Container,
          newChildren: Array<Instance | TextInstance>,
        ): void {
          container.children = newChildren;
        },
      },
    })
  : null;

var rootContainers = new Map();
var roots = new Map();
var persistentRoots = new Map();
var DEFAULT_ROOT_ID = '<default>';

let yieldedValues = null;

function* flushUnitsOfWork(n: number): Generator<Array<mixed>, void, void> {
  var didStop = false;
  while (!didStop && scheduledCallback !== null) {
    var cb = scheduledCallback;
    scheduledCallback = null;
    yieldedValues = null;
    var unitsRemaining = n;
    cb({
      timeRemaining() {
        if (yieldedValues !== null) {
          return 0;
        }
        if (unitsRemaining-- > 0) {
          return 999;
        }
        didStop = true;
        return 0;
      },
    });

    if (yieldedValues !== null) {
      const values = yieldedValues;
      yieldedValues = null;
      yield values;
    }
  }
}

var ReactNoop = {
  getChildren(rootID: string = DEFAULT_ROOT_ID) {
    const container = rootContainers.get(rootID);
    if (container) {
      return container.children;
    } else {
      return null;
    }
  },

  // Shortcut for testing a single root
  render(element: React$Element<any>, callback: ?Function) {
    ReactNoop.renderToRootWithID(element, DEFAULT_ROOT_ID, callback);
  },

  renderToRootWithID(
    element: React$Element<any>,
    rootID: string,
    callback: ?Function,
  ) {
    let root = roots.get(rootID);
    if (!root) {
      const container = {rootID: rootID, children: []};
      rootContainers.set(rootID, container);
      root = NoopRenderer.createContainer(container, false);
      roots.set(rootID, root);
    }
    NoopRenderer.updateContainer(element, root, null, callback);
  },

  renderToPersistentRootWithID(
    element: React$Element<any>,
    rootID: string,
    callback: ?Function,
  ) {
    if (PersistentNoopRenderer === null) {
      throw new Error(
        'Enable ReactFeatureFlags.enablePersistentReconciler to use it in tests.',
      );
    }
    let root = persistentRoots.get(rootID);
    if (!root) {
      const container = {rootID: rootID, children: []};
      rootContainers.set(rootID, container);
      root = PersistentNoopRenderer.createContainer(container, false);
      persistentRoots.set(rootID, root);
    }
    PersistentNoopRenderer.updateContainer(element, root, null, callback);
  },

  unmountRootWithID(rootID: string) {
    const root = roots.get(rootID);
    if (root) {
      NoopRenderer.updateContainer(null, root, null, () => {
        roots.delete(rootID);
        rootContainers.delete(rootID);
      });
    }
  },

  findInstance(
    componentOrElement: Element | ?React$Component<any, any>,
  ): null | Instance | TextInstance {
    if (componentOrElement == null) {
      return null;
    }
    // Unsound duck typing.
    const component = (componentOrElement: any);
    if (typeof component.id === 'number') {
      return component;
    }
    const inst = ReactInstanceMap.get(component);
    return inst ? NoopRenderer.findHostInstance(inst) : null;
  },

  flushDeferredPri(timeout: number = Infinity): Array<mixed> {
    // The legacy version of this function decremented the timeout before
    // returning the new time.
    // TODO: Convert tests to use flushUnitsOfWork or flushAndYield instead.
    const n = timeout / 5 - 1;

    let values = [];
    for (const value of flushUnitsOfWork(n)) {
      values.push(...value);
    }
    return values;
  },

  flush(): Array<mixed> {
    return ReactNoop.flushUnitsOfWork(Infinity);
  },

  flushAndYield(
    unitsOfWork: number = Infinity,
  ): Generator<Array<mixed>, void, void> {
    return flushUnitsOfWork(unitsOfWork);
  },

  flushUnitsOfWork(n: number): Array<mixed> {
    let values = [];
    for (const value of flushUnitsOfWork(n)) {
      values.push(...value);
    }
    return values;
  },

  flushThrough(expected: Array<mixed>): void {
    let actual = [];
    if (expected.length !== 0) {
      for (const value of flushUnitsOfWork(Infinity)) {
        actual.push(...value);
        if (actual.length >= expected.length) {
          break;
        }
      }
    }
    expect(actual).toEqual(expected);
  },

  expire(ms: number): void {
    elapsedTimeInMs += ms;
  },

  flushExpired(): Array<mixed> {
    return ReactNoop.flushUnitsOfWork(0);
  },

  yield(value: mixed) {
    if (yieldedValues === null) {
      yieldedValues = [value];
    } else {
      yieldedValues.push(value);
    }
  },

  hasScheduledCallback() {
    return !!scheduledCallback;
  },

  batchedUpdates: NoopRenderer.batchedUpdates,

  deferredUpdates: NoopRenderer.deferredUpdates,

  unbatchedUpdates: NoopRenderer.unbatchedUpdates,

  flushSync: NoopRenderer.flushSync,

  // Logs the current state of the tree.
  dumpTree(rootID: string = DEFAULT_ROOT_ID) {
    const root = roots.get(rootID);
    const rootContainer = rootContainers.get(rootID);
    if (!root || !rootContainer) {
      console.log('Nothing rendered yet.');
      return;
    }

    var bufferedLog = [];
    function log(...args) {
      bufferedLog.push(...args, '\n');
    }

    function logHostInstances(children: Array<Instance | TextInstance>, depth) {
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        var indent = '  '.repeat(depth);
        if (typeof child.text === 'string') {
          log(indent + '- ' + child.text);
        } else {
          // $FlowFixMe - The child should've been refined now.
          log(indent + '- ' + child.type + '#' + child.id);
          // $FlowFixMe - The child should've been refined now.
          logHostInstances(child.children, depth + 1);
        }
      }
    }
    function logContainer(container: Container, depth) {
      log('  '.repeat(depth) + '- [root#' + container.rootID + ']');
      logHostInstances(container.children, depth + 1);
    }

    function logUpdateQueue(updateQueue: UpdateQueue<mixed>, depth) {
      log('  '.repeat(depth + 1) + 'QUEUED UPDATES');
      const firstUpdate = updateQueue.first;
      if (!firstUpdate) {
        return;
      }

      log(
        '  '.repeat(depth + 1) + '~',
        firstUpdate && firstUpdate.partialState,
        firstUpdate.callback ? 'with callback' : '',
        '[' + firstUpdate.expirationTime + ']',
      );
      var next;
      while ((next = firstUpdate.next)) {
        log(
          '  '.repeat(depth + 1) + '~',
          next.partialState,
          next.callback ? 'with callback' : '',
          '[' + firstUpdate.expirationTime + ']',
        );
      }
    }

    function logFiber(fiber: Fiber, depth) {
      log(
        '  '.repeat(depth) +
          '- ' +
          // need to explicitly coerce Symbol to a string
          (fiber.type ? fiber.type.name || fiber.type.toString() : '[root]'),
        '[' + fiber.expirationTime + (fiber.pendingProps ? '*' : '') + ']',
      );
      if (fiber.updateQueue) {
        logUpdateQueue(fiber.updateQueue, depth);
      }
      // const childInProgress = fiber.progressedChild;
      // if (childInProgress && childInProgress !== fiber.child) {
      //   log(
      //     '  '.repeat(depth + 1) + 'IN PROGRESS: ' + fiber.pendingWorkPriority,
      //   );
      //   logFiber(childInProgress, depth + 1);
      //   if (fiber.child) {
      //     log('  '.repeat(depth + 1) + 'CURRENT');
      //   }
      // } else if (fiber.child && fiber.updateQueue) {
      //   log('  '.repeat(depth + 1) + 'CHILDREN');
      // }
      if (fiber.child) {
        logFiber(fiber.child, depth + 1);
      }
      if (fiber.sibling) {
        logFiber(fiber.sibling, depth);
      }
    }

    log('HOST INSTANCES:');
    logContainer(rootContainer, 0);
    log('FIBERS:');
    logFiber(root.current, 0);

    console.log(...bufferedLog);
  },

  simulateErrorInHostConfig(fn: () => void) {
    failInBeginPhase = true;
    try {
      fn();
    } finally {
      failInBeginPhase = false;
    }
  },

  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
    // Private. Used only by fixtures/fiber-debugger.
    ReactFiberInstrumentation,
  },
};

export default ReactNoop;
