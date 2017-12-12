// @flow
import Perf from 'react-addons-perf';
import type {
  DraggableId,
  DroppableId,
  DroppableDescriptor,
  DraggableDescriptor,
  DraggableDimension,
  DroppableDimension,
  State as AppState,
  Phase,
} from '../../types';
import type {
  Marshal,
  Callbacks,
  GetDraggableDimensionFn,
  DroppableCallbacks,
  OrderedCollectionList,
  OrderedDimensionList,
  UnknownDimensionType,
  UnknownDescriptorType,
  DroppableEntry,
  DraggableEntry,
  DroppableEntryMap,
  DraggableEntryMap,
} from './dimension-marshal-types';

// Not using exact type to allow spread to create a new state object
type State = {
  droppables: DroppableEntryMap,
  draggables: DraggableEntryMap,
  isCollecting: boolean,
  timers: {|
    liftTimeoutId: ?number,
    collectionFrameId: ?number,
  |}
}

type ToBePublished = {|
  draggables: DraggableDimension[],
  droppables: DroppableDimension[],
|}

type Timers = {|
  liftTimeoutId: ?number,
  collectionFrameId: ?number,
|}

const noTimers: Timers = {
  liftTimeoutId: null,
  collectionFrameId: null,
};

export default (callbacks: Callbacks) => {
  let state: State = {
    droppables: {},
    draggables: {},
    isCollecting: false,
    timers: noTimers,
  };

  const setState = (newState: State) => {
    state = newState;
  };

  const registerDraggable = (
    descriptor: DraggableDescriptor,
    getDimension: GetDraggableDimensionFn
  ) => {
    const id: DraggableId = descriptor.id;

    if (state.draggables[id]) {
      console.error(`Cannot register Draggable with id ${id} as one is already registered`);
      return;
    }

    const entry: DraggableEntry = {
      descriptor,
      getDimension,
    };
    const draggables: DraggableEntryMap = {
      ...state.draggables,
      [id]: entry,
    };

    setState({
      ...state,
      draggables,
    });

    if (!state.collection) {
      return;
    }

    // currently collecting - publish!
    console.log('publishing droppable mid collection');
    const dimension: DraggableDimension = entry.getDimension();
    callbacks.publishDraggables([dimension]);
  };

  const registerDroppable = (
    descriptor: DroppableDescriptor,
    droppableCallbacks: DroppableCallbacks,
  ) => {
    const id: DroppableId = descriptor.id;

    if (state.droppables[id]) {
      console.error(`Cannot register Droppable with id ${id} as one is already registered`);
      return;
    }

    const entry: DroppableEntry = {
      descriptor,
      callbacks: droppableCallbacks,
    };

    const droppables: DroppableEntryMap = {
      ...state.droppables,
      [id]: entry,
    };

    setState({
      ...state,
      droppables,
    });

    if (!state.collection) {
      return;
    }

    // currently collecting - publish!
    console.log('publishing droppable mid collection');
    const dimension: DroppableDimension = entry.callbacks.getDimension();
    callbacks.publishDroppables([dimension]);
  };

  const unregisterDraggable = (id: DraggableId) => {
    if (!state.draggables[id]) {
      console.error(`Cannot unregister Draggable with id ${id} as as it is not registered`);
      return;
    }
    const newMap: DraggableEntryMap = {
      ...state.draggables,
    };
    delete newMap[id];

    setState({
      ...state,
      draggables: newMap,
    });

    if (!state.collection) {
      return;
    }

    console.warn('currently not supporting unmounting a Draggable during a drag');
  };

  const unregisterDroppable = (id: DroppableId) => {
    if (!state.droppables[id]) {
      console.error(`Cannot unregister Droppable with id ${id} as as it is not registered`);
      return;
    }
    const newMap: DroppableEntryMap = {
      ...state.droppables,
    };
    delete newMap[id];

    setState({
      ...state,
      droppables: newMap,
    });

    if (!state.collection) {
      return;
    }

    // TODO: actually unpublish
    console.warn('currently not supporting unmounting a Droppable during a drag');
  };

  const setFrameId = (frameId: ?number) => {
    const timers: Timers = {
      collectionFrameId: frameId,
      liftTimeoutId: null,
    };

    setState({
      ...state,
      timers,
    });
  };

  const collect = (toBeCollected: UnknownDescriptorType[]) => {
    // Phase 1: collect dimensions in a single frame
    const collectFrameId: number = requestAnimationFrame(() => {
      console.time('collecting raw dimensions');
      const toBePublishedBuffer: UnknownDimensionType[] = toBeCollected.map(
        (descriptor: UnknownDescriptorType): UnknownDimensionType => {
          // is a droppable
          if (descriptor.type) {
            return state.droppables[descriptor.id].callbacks.getDimension();
          }
          // is a draggable
          return state.draggables[descriptor.id].getDimension();
        }
      );
      console.timeEnd('collecting raw dimensions');

      // Phase 2: publish all dimensions to the store
      const publishFrameId: number = requestAnimationFrame(() => {
        console.time('publishing dimensions');
        const toBePublished: ToBePublished = toBePublishedBuffer.reduce(
          (previous: ToBePublished, dimension: UnknownDimensionType): ToBePublished => {
            // is a draggable
            if (dimension.placeholder) {
              previous.draggables.push(dimension);
            } else {
              previous.droppables.push(dimension);
            }
            return previous;
          }, { draggables: [], droppables: [] }
        );

        callbacks.publishDroppables(toBePublished.droppables);
        callbacks.publishDraggables(toBePublished.draggables);

        // need to watch the scroll on each droppable
        toBePublished.droppables.forEach((dimension: DroppableDimension) => {
          const entry: DroppableEntry = state.droppables[dimension.descriptor.id];
          entry.callbacks.watchScroll(callbacks.updateDroppableScroll);
        });

        setFrameId(null);
        console.timeEnd('publishing dimensions');
      });

      setFrameId(publishFrameId);
    });

    setFrameId(collectFrameId);
  };

  const startInitialCollection = (descriptor: DraggableDescriptor) => {
    if (state.dragging) {
      console.error('Cannot start capturing dimensions for a drag it is already dragging');
      callbacks.cancel();
      return;
    }

    const draggables: DraggableEntryMap = state.draggables;
    const droppables: DroppableEntryMap = state.droppables;

    const draggableEntry: ?DraggableEntry = draggables[descriptor.id];

    if (!draggableEntry) {
      console.error(`Cannot find Draggable with id ${descriptor.id} to start collecting dimensions`);
      callbacks.cancel();
      return;
    }

    const homeEntry: ?DroppableEntry = droppables[draggableEntry.descriptor.droppableId];

    if (!homeEntry) {
      console.error(`Cannot find home Droppable [id:${draggableEntry.descriptor.droppableId}] for Draggable [id:${descriptor.id}]`);
      callbacks.cancel();
      return;
    }

    console.time('initial dimension publish');

    // Get the minimum dimensions to start a drag
    const home: DroppableDimension = homeEntry.callbacks.getDimension();
    const draggable: DraggableDimension = draggableEntry.getDimension();
    // Publishing dimensions
    callbacks.publishDroppables([home]);
    callbacks.publishDraggables([draggable]);
    // Watching the scroll of the home droppable
    homeEntry.callbacks.watchScroll(callbacks.updateDroppableScroll);

    const draggablesToBeCollected: DraggableDescriptor[] =
      Object.keys(draggables)
        .map((id: DraggableId): DraggableDescriptor => draggables[id].descriptor)
        // remove the original draggable from the list
        .filter((d: DraggableDescriptor): boolean => d.id !== descriptor.id)
        // remove draggables that do not have the same droppable type
        .filter((d: DraggableDescriptor): boolean => {
          const droppable: DroppableDescriptor = droppables[d.droppableId].descriptor;
          return droppable.type === home.descriptor.type;
        });

    const droppablesToBeCollected: DroppableDescriptor[] =
      Object.keys(droppables)
        // remove the home droppable from the list
        .filter((d: DroppableDescriptor): boolean => d.id !== home.descriptor.id)
      // remove droppables with a different type
        .filter((d: DroppableDescriptor): boolean => {
          const droppable: DroppableDescriptor = droppables[d.id].descriptor;
          return droppable.type === home.descriptor.type;
        });

    const toBeCollected: UnknownDescriptorType[] = [
      ...droppablesToBeCollected,
      ...draggablesToBeCollected,
    ];

    console.timeEnd('initial dimension publish');

    // After this initial publish a drag will start
    const liftTimeoutId: number = setTimeout(() => collect(toBeCollected));

    const timers: Timers = {
      liftTimeoutId,
      collectionFrameId: null,
    };

    setState({
      ...state,
      timers,
    });
  };

  const stopCollecting = () => {
    if (!state.isCollecting) {
      console.warn('not stopping dimension capturing as was not previously capturing');
      return;
    }

    // Tell all droppables to stop watching scroll
    // all good if they where not already listening
    Object.keys(state.droppables)
      .map((id: DroppableId): DroppableEntry => state.droppables[id])
      .forEach((entry: DroppableEntry) => entry.callbacks.unwatchScroll());

    if (state.timers.liftTimeoutId) {
      clearTimeout(state.timers.liftTimeoutId);
    }

    if (state.timers.collectionFrameId) {
      cancelAnimationFrame(state.timers.collectionFrameId);
    }

    // clear the collection
    setState({
      ...state,
      isCollecting: false,
      timers: noTimers,
    });
  };

  const onStateChange = (current: AppState) => {
    const phase: Phase = current.phase;

    if (phase === 'COLLECTING_INITIAL_DIMENSIONS') {
      const descriptor: ?DraggableDescriptor = current.dimension.request;

      if (!descriptor) {
        console.error('could not find requested draggable id in state');
        callbacks.cancel();
        return;
      }

      startInitialCollection(descriptor);
    }

    // No need to collect any more as the user has finished interacting
    if (phase === 'DROP_ANIMATING' || phase === 'DROP_COMPLETE') {
      if (state.isCollecting);
        stopCollecting();
      }
      return;
    }

    // drag potentially cleanled
    if (phase === 'IDLE') {
      if (state.isCollecting) {
        stopCollecting();
      }
    }
  };

  const marshal: Marshal = {
    registerDraggable,
    registerDroppable,
    unregisterDraggable,
    unregisterDroppable,
    onStateChange,
  };

  return marshal;
}
