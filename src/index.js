// @flow
import type {
  JQueryWrapper,
  State,
  Options,
  UpdateCallback,
  EventListeners,
  Rect,
  Modifier,
} from './types';

// DOM Utils
import getElementClientRect from './dom-utils/getElementClientRect';
import listScrollParents from './dom-utils/listScrollParents';
import getWindow from './dom-utils/getWindow';
import getNodeScroll from './dom-utils/getNodeScroll';
import getOffsetParent from './dom-utils/getOffsetParent';
import getCommonTotalScroll from './dom-utils/getCommonTotalScroll';

// Pure Utils
import unwrapJqueryElement from './utils/unwrapJqueryElement';
import orderModifiers from './utils/orderModifiers';
import expandToHashMap from './utils/expandToHashMap';
import computeOffsets from './utils/computeOffsets';
import format from './utils/format';
import debounce from './utils/debounce';
import validateModifiers from './utils/validateModifiers';

// Default modifiers
import * as modifiers from './modifiers/index';

const defaultModifiers: Array<Modifier> = (Object.values(modifiers): any);

const INVALID_ELEMENT_ERROR =
  'Popper: Invalid `%s` argument provided to Popper, it must be either a valid DOM element or a jQuery-wrapped DOM element, you provided `%s`';
const INFINITE_LOOP_ERROR =
  'Popper: An infinite loop in the modifiers cycle has been detected! The cycle has been interrupted to prevent a browser crash.';

const areValidElements = (a: mixed, b: mixed): boolean %checks =>
  a instanceof Element && b instanceof Element;

const defaultOptions = {
  placement: 'bottom',
  eventListeners: { scroll: true, resize: true },
  modifiers: [],
  strategy: 'absolute',
};

export default class Popper {
  state: $Shape<State> = {
    placement: 'bottom',
    orderedModifiers: [],
    options: defaultOptions,
    modifiersData: {},
  };

  constructor(
    reference: Element | JQueryWrapper,
    popper: Element | JQueryWrapper,
    options: $Shape<Options> = defaultOptions
  ) {
    // Unwrap `reference` and `popper` elements in case they are
    // wrapped by jQuery, otherwise consume them as is
    this.state.elements = {
      reference: unwrapJqueryElement(reference),
      popper: unwrapJqueryElement(popper),
    };
    const {
      reference: referenceElement,
      popper: popperElement,
    } = this.state.elements;

    // Store options into state
    this.state.options = { ...defaultOptions, ...options };

    // Don't proceed if `reference` or `popper` are invalid elements
    if (!areValidElements(referenceElement, popperElement)) {
      return;
    }

    this.state.scrollParents = {
      reference: listScrollParents(referenceElement),
      popper: listScrollParents(popperElement),
    };

    // Order `options.modifiers` so that the dependencies are fulfilled
    // once the modifiers are executed
    this.state.orderedModifiers = orderModifiers([
      ...defaultModifiers,
      ...this.state.options.modifiers,
    ])
      // Apply user defined preferences to modifiers
      .map(modifier => ({
        ...modifier,
        ...this.state.options.modifiers.find(
          ({ name }) => name === modifier.name
        ),
      }));

    // Validate the provided modifiers so that the consumer will get warned
    // of one of the custom modifiers is invalid for any reason
    if (__DEV__) {
      validateModifiers(this.state.options.modifiers);
    }

    // Modifiers have the opportunity to execute some arbitrary code before
    // the first update cycle is ran, the order of execution will be the same
    // defined by the modifier dependencies directive.
    // The `onLoad` function may add or alter the options of themselves
    this.state.orderedModifiers.forEach(
      ({ onLoad, enabled }) => enabled && onLoad && onLoad(this.state)
    );

    this.update().then(() => {
      // After the first update completed, enable the event listeners
      this.enableEventListeners(this.state.options.eventListeners);
    });
  }

  // Async and optimistically optimized update
  // it will not be executed if not necessary
  // debounced, so that it only runs at most once-per-tick
  update = debounce(
    () =>
      new Promise<State>((success, reject) => {
        this.forceUpdate();
        success(this.state);
      })
  );

  // Syncronous and forcefully executed update
  // it will always be executed even if not necessary, usually NOT needed
  // use Popper#update instead
  forceUpdate() {
    const {
      reference: referenceElement,
      popper: popperElement,
    } = this.state.elements;
    // Don't proceed if `reference` or `popper` are not valid elements anymore
    if (!areValidElements(referenceElement, popperElement)) {
      return;
    }

    // Get initial measurements
    // these are going to be used to compute the initial popper offsets
    // and as cache for any modifier that needs them later
    this.state.measures = {
      reference: getElementClientRect(referenceElement),
      popper: getElementClientRect(popperElement),
    };

    // Get scrollTop and scrollLeft of the offsetParent
    // this will be used in the `computeOffsets` function to properly
    // position the popper taking in account the scroll position
    // FIXME: right now we only look for a single offsetParent (the popper one)
    //        but we really want to take in account the reference offsetParent as well
    const offsetParentScroll = getNodeScroll(getOffsetParent(popperElement));

    // Modifiers have the ability to read the current Popper state, included
    // the popper offsets, and modify it to address specifc cases
    this.state.reset = false;

    // Cache the placement in cache to make it available to the modifiers
    // modifiers will modify this one (rather than the one in options)
    this.state.placement = this.state.options.placement;

    this.state.orderedModifiers.forEach(
      modifier =>
        (this.state.modifiersData[modifier.name] = {
          ...modifier.data,
        })
    );

    let __debug_loops__ = 0;
    for (let index = 0; index < this.state.orderedModifiers.length; index++) {
      if (__DEV__) {
        __debug_loops__ += 1;
        if (__debug_loops__ > 100) {
          console.error(INFINITE_LOOP_ERROR);
          break;
        }
      }
      if (index === 0) {
        // Offsets are the actual position the popper needs to have to be
        // properly positioned near its reference element
        // This is the most basic placement, and will be adjusted by
        // the modifiers in the next step
        this.state.offsets = {
          popper: computeOffsets({
            reference: this.state.measures.reference,
            element: this.state.measures.popper,
            strategy: 'absolute',
            placement: this.state.placement,
            scroll: getCommonTotalScroll(
              referenceElement,
              this.state.scrollParents.reference,
              this.state.scrollParents.popper
            ),
          }),
        };
      }

      if (this.state.reset === true) {
        this.state.reset = false;
        index = -1;
        continue;
      }

      const { fn, enabled, options } = this.state.orderedModifiers[index];

      if (enabled && typeof fn === 'function') {
        this.state = fn((this.state: State), options);
      }
    }
  }

  enableEventListeners(
    eventListeners: boolean | {| scroll?: boolean, resize?: boolean |}
  ) {
    const {
      reference: referenceElement,
      popper: popperElement,
    } = this.state.elements;
    const { scroll, resize } =
      typeof eventListeners === 'boolean'
        ? expandToHashMap(eventListeners, ['scroll', 'resize'])
        : eventListeners;

    if (scroll) {
      const scrollParents = [
        ...this.state.scrollParents.reference,
        ...this.state.scrollParents.popper,
      ];

      scrollParents.forEach(scrollParent =>
        scrollParent.addEventListener('scroll', this.update, {
          passive: true,
        })
      );
    }

    if (resize) {
      const window = getWindow(this.state.elements.popper);
      window.addEventListener('resize', this.update, {
        passive: true,
      });
    }
  }

  destroy() {
    // Remove scroll event listeners
    const scrollParents = [
      ...this.state.scrollParents.reference,
      ...this.state.scrollParents.popper,
    ];

    scrollParents.forEach(scrollParent =>
      scrollParent.removeEventListener('scroll', this.update)
    );

    // Remove resize event listeners
    const window = getWindow(this.state.elements.popper);
    window.removeEventListener('resize', this.update);

    // Run `onDestroy` modifier methods
    this.state.orderedModifiers.forEach(
      ({ onDestroy, enabled }) => enabled && onDestroy && onDestroy(this.state)
    );
  }
}
