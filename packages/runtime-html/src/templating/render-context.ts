import { InstanceProvider } from '@aurelia/kernel';
import { FragmentNodeSequence, INode, INodeSequence, IRenderLocation } from '../dom.js';
import { IRenderer, ITemplateCompiler, IInstruction, ICompliationInstruction } from '../renderer.js';
import { CustomElementDefinition } from '../resources/custom-element.js';
import { CustomAttribute } from '../resources/custom-attribute.js';
import { IViewFactory, ViewFactory } from './view.js';
import { AuSlotsInfo, IAuSlotsInfo, IProjections } from '../resources/custom-elements/au-slot.js';
import { IPlatform } from '../platform.js';
import { IController } from './controller.js';

import type {
  Constructable,
  IContainer,
  IFactory,
  IResolver,
  IResourceKind,
  Key,
  Resolved,
  ResourceDefinition,
  ResourceType,
  Transformer,
} from '@aurelia/kernel';
import type { LifecycleFlags } from '@aurelia/runtime';
import type { ICustomAttributeViewModel, ICustomElementViewModel, IHydratableController } from './controller.js';
import type {
  Instruction,
  InstructionTypeName,
  HydrateAttributeInstruction,
  HydrateTemplateController,
  HydrateElementInstruction,
} from '../renderer.js';
import type { PartialCustomElementDefinition } from '../resources/custom-element.js';

const definitionContainerLookup = new WeakMap<CustomElementDefinition, WeakMap<IContainer, RenderContext>>();
const definitionContainerProjectionsLookup = new WeakMap<CustomElementDefinition, WeakMap<IContainer, WeakMap<Record<string, CustomElementDefinition>, RenderContext>>>();

const fragmentCache = new WeakMap<CustomElementDefinition, Node | null>();

export function isRenderContext(value: unknown): value is IRenderContext {
  return value instanceof RenderContext;
}

/**
 * A render context that wraps an `IContainer` and must be compiled before it can be used for composing.
 */
export interface IRenderContext extends IContainer {
  readonly platform: IPlatform;

  /**
   * The `CustomElementDefinition` that this `IRenderContext` was created with.
   *
   * If a `PartialCustomElementDefinition` was used to create this context, then this property will be the return value of `CustomElementDefinition.getOrCreate`.
   */
  readonly definition: CustomElementDefinition;

  /**
   * The `IContainer` (which may be, but is not guaranteed to be, an `IRenderContext`) that this `IRenderContext` was created with.
   */
  readonly parentContainer: IContainer;

  readonly container: IContainer;

  /**
   * Compiles the backing `CustomElementDefinition` (if needed) and returns the compiled `IRenderContext` that exposes the compiled `CustomElementDefinition` as well as composing operations.
   *
   * This operation is idempotent.
   *
   * @returns The compiled `IRenderContext`.
   */
  compile(compilationInstruction: ICompliationInstruction | null): ICompiledRenderContext;

  /**
   * Creates an (or returns the cached) `IViewFactory` that can be used to create synthetic view controllers.
   *
   * @returns Either a new `IViewFactory` (if this is the first call), or a cached one.
   */
  getViewFactory(name?: string): IViewFactory;
}

/**
 * A compiled `IRenderContext` that can create instances of `INodeSequence` (based on the template of the compiled definition)
 * and begin a component operation to create new component instances.
 */
export interface ICompiledRenderContext extends IRenderContext {
  /**
   * The compiled `CustomElementDefinition`.
   *
   * If the passed-in `PartialCustomElementDefinition` had a non-null `template` and `needsCompile` set to `true`, this will be a new definition created by the `ITemplateCompiler`.
   */
  readonly compiledDefinition: CustomElementDefinition;

  /**
   * Returns a new `INodeSequence` based on the document fragment from the compiled `CustomElementDefinition`.
   *
   * A new instance will be created from a clone of the fragment on each call.
   *
   * @returns An new instance of `INodeSequence` if there is a template, otherwise a shared empty instance.
   */
  createNodes(): INodeSequence;

  /**
   * Prepare a new container to associate with a custom element instance
   */
  createElementContainer(
    parentController: IController,
    host: HTMLElement,
    instruction: HydrateElementInstruction,
    viewFactory?: IViewFactory,
    location?: IRenderLocation,
    auSlotsInfo?: IAuSlotsInfo,
  ): IContainer;

  /**
   * Instantiate a custom attribute
   */
  invokeAttribute(
    parentController: IController,
    host: HTMLElement,
    instruction: HydrateAttributeInstruction | HydrateTemplateController,
    viewFactory?: IViewFactory,
    location?: IRenderLocation,
    auSlotsInfo?: IAuSlotsInfo,
  ): ICustomAttributeViewModel;

  render(
    flags: LifecycleFlags,
    controller: IController,
    targets: ArrayLike<INode>,
    templateDefinition: CustomElementDefinition,
    host: INode | null | undefined,
  ): void;

  renderChildren(
    flags: LifecycleFlags,
    instructions: readonly IInstruction[],
    controller: IController,
    target: unknown,
  ): void;
}

let renderContextCount = 0;
export function getRenderContext(
  partialDefinition: PartialCustomElementDefinition,
  container: IContainer,
  projections?: IProjections | null,
): IRenderContext {
  const definition = CustomElementDefinition.getOrCreate(partialDefinition);

  // injectable completely prevents caching, ensuring that each instance gets a new context context
  if (definition.injectable !== null) {
    return new RenderContext(definition, container);
  }

  if (projections == null) {
    let containerLookup = definitionContainerLookup.get(definition);
    if (containerLookup === void 0) {
      definitionContainerLookup.set(
        definition,
        containerLookup = new WeakMap(),
      );
    }

    let context = containerLookup.get(container);
    if (context === void 0) {
      containerLookup.set(
        container,
        context = new RenderContext(definition, container),
      );
    }

    return context;
  }

  let containerProjectionsLookup = definitionContainerProjectionsLookup.get(definition);
  if (containerProjectionsLookup === void 0) {
    definitionContainerProjectionsLookup.set(
      definition,
      containerProjectionsLookup = new WeakMap(),
    );
  }

  let projectionsLookup = containerProjectionsLookup.get(container);
  if (projectionsLookup === void 0) {
    containerProjectionsLookup.set(
      container,
      projectionsLookup = new WeakMap(),
    );
  }

  let context = projectionsLookup.get(projections);
  if (context === void 0) {
    projectionsLookup.set(
      projections,
      context = new RenderContext(definition, container),
    );
  }

  return context;
}
getRenderContext.count = 0;
// A simple counter for debugging purposes only
Reflect.defineProperty(getRenderContext, 'count', {
  get: () => renderContextCount
});

const emptyNodeCache = new WeakMap<IPlatform, FragmentNodeSequence>();

export class RenderContext implements ICompiledRenderContext {
  public get id(): number {
    return this.container.id;
  }

  public readonly root: IContainer;
  public readonly container: IContainer;

  private readonly parentControllerProvider: InstanceProvider<IController>;
  private readonly elementProvider: InstanceProvider<HTMLElement>;
  private readonly instructionProvider: InstanceProvider<Instruction>;
  private readonly factoryProvider: ViewFactoryProvider;
  private readonly renderLocationProvider: InstanceProvider<IRenderLocation>;
  private readonly auSlotsInfoProvider: InstanceProvider<IAuSlotsInfo>;

  private fragment: Node | null = null;
  private factory: IViewFactory | undefined = void 0;
  private isCompiled: boolean = false;

  public readonly platform: IPlatform;
  private readonly renderers: Record<InstructionTypeName, IRenderer> = Object.create(null);

  public compiledDefinition: CustomElementDefinition = (void 0)!;

  public constructor(
    public readonly definition: CustomElementDefinition,
    public readonly parentContainer: IContainer,
  ) {
    ++renderContextCount;
    const container = this.container = parentContainer;
    // TODO(fkleuver): get contextual + root renderers
    const renderers = container.getAll(IRenderer);
    let i = 0;
    let renderer: IRenderer;
    for (; i < renderers.length; ++i) {
      renderer = renderers[i];
      this.renderers[renderer.instructionType as string] = renderer;
    }

    this.root = parentContainer.root;
    this.platform = container.get(IPlatform);
    this.elementProvider = new InstanceProvider('ElementResolver');
    this.factoryProvider = new ViewFactoryProvider();
    this.parentControllerProvider = new InstanceProvider('IController');
    this.instructionProvider = new InstanceProvider<Instruction>('IInstruction');
    this.renderLocationProvider = new InstanceProvider<IRenderLocation>('IRenderLocation');
    this.auSlotsInfoProvider = new InstanceProvider<IAuSlotsInfo>('IAuSlotsInfo');
  }

  // #region IServiceLocator api
  public has<K extends Key>(key: K | Key, searchAncestors: boolean): boolean {
    return this.container.has(key, searchAncestors);
  }

  public get<K extends Key>(key: K | Key): Resolved<K> {
    return this.container.get(key);
  }

  public getAll<K extends Key>(key: K | Key): readonly Resolved<K>[] {
    return this.container.getAll(key);
  }
  // #endregion

  // #region IContainer api
  public register(...params: unknown[]): IContainer {
    return this.container.register(...params);
  }

  public registerResolver<K extends Key, T = K>(key: K, resolver: IResolver<T>): IResolver<T> {
    return this.container.registerResolver(key, resolver);
  }

  // public deregisterResolverFor<K extends Key, T = K>(key: K): void {
  //   this.container.deregisterResolverFor(key);
  // }

  public registerTransformer<K extends Key, T = K>(key: K, transformer: Transformer<T>): boolean {
    return this.container.registerTransformer(key, transformer);
  }

  public getResolver<K extends Key, T = K>(key: K | Key, autoRegister?: boolean): IResolver<T> | null {
    return this.container.getResolver(key, autoRegister);
  }

  public invoke<T, TDeps extends unknown[] = unknown[]>(key: Constructable<T>, dynamicDependencies?: TDeps): T {
    return this.container.invoke(key, dynamicDependencies);
  }

  public getFactory<T extends Constructable>(key: T): IFactory<T> {
    return this.container.getFactory(key);
  }

  public registerFactory<K extends Constructable>(key: K, factory: IFactory<K>): void {
    this.container.registerFactory(key, factory);
  }

  public createChild(): IContainer {
    return this.container.createChild();
  }

  public find<TType extends ResourceType, TDef extends ResourceDefinition>(kind: IResourceKind<TType, TDef>, name: string): TDef | null {
    return this.container.find(kind, name);
  }

  public create<TType extends ResourceType, TDef extends ResourceDefinition>(kind: IResourceKind<TType, TDef>, name: string): InstanceType<TType> | null {
    return this.container.create(kind, name);
  }

  public disposeResolvers() {
    this.container.disposeResolvers();
  }
  // #endregion

  // #region IRenderContext api
  public compile(compilationInstruction: ICompliationInstruction | null): ICompiledRenderContext {
    let compiledDefinition: CustomElementDefinition;
    if (this.isCompiled) {
      return this;
    }
    this.isCompiled = true;

    const definition = this.definition;
    if (definition.needsCompile) {
      const container = this.container;
      const compiler = container.get(ITemplateCompiler);

      compiledDefinition = this.compiledDefinition = compiler.compile(definition, container, compilationInstruction);
    } else {
      compiledDefinition = this.compiledDefinition = definition;
    }

    // Support Recursive Components by adding self to own context
    compiledDefinition.register(this);

    if (fragmentCache.has(compiledDefinition)) {
      this.fragment = fragmentCache.get(compiledDefinition)!;
    } else {
      const doc = this.platform.document;
      const template = compiledDefinition.template;
      if (template === null || this.definition.enhance === true) {
        this.fragment = null;
      } else if (template instanceof this.platform.Node) {
        if (template.nodeName === 'TEMPLATE') {
          this.fragment = doc.adoptNode((template as HTMLTemplateElement).content);
        } else {
          (this.fragment = doc.adoptNode(doc.createDocumentFragment())).appendChild(template);
        }
      } else {
        const tpl = doc.createElement('template');
        doc.adoptNode(tpl.content);
        if (typeof template === 'string') {
          tpl.innerHTML = template;
        }
        this.fragment = tpl.content;
      }
      fragmentCache.set(compiledDefinition, this.fragment);
    }

    return this;
  }

  public getViewFactory(name?: string): IViewFactory {
    let factory = this.factory;
    if (factory === void 0) {
      if (name === void 0) {
        name = this.definition.name;
      }
      factory = this.factory = new ViewFactory(name, this);
    }
    return factory;
  }
  // #endregion

  // #region ICompiledRenderContext api

  public createNodes(): INodeSequence {
    if (this.compiledDefinition.enhance === true) {
      return new FragmentNodeSequence(this.platform, this.compiledDefinition.template as DocumentFragment);
    }
    if (this.fragment === null) {
      let emptyNodes = emptyNodeCache.get(this.platform);
      if (emptyNodes === void 0) {
        emptyNodeCache.set(this.platform, emptyNodes = new FragmentNodeSequence(this.platform, this.platform.document.createDocumentFragment()));
      }
      return emptyNodes;
    }
    return new FragmentNodeSequence(this.platform, this.fragment.cloneNode(true) as DocumentFragment);
  }
  // #endregion

  public createElementContainer(
    parentController: IController,
    host: HTMLElement,
    instruction: HydrateElementInstruction,
    viewFactory?: IViewFactory,
    location?: IRenderLocation,
    auSlotsInfo?: IAuSlotsInfo,
  ): IContainer {
    const ctxContainer = this.container;
    const p = this.platform;
    const container = ctxContainer.createChild();

    const nodeProvider: InstanceProvider<INode> = new InstanceProvider('ElementProvider');
    const controllerProvider: InstanceProvider<IController> = new InstanceProvider('IController');
    const instructionProvider: InstanceProvider<IInstruction> = new InstanceProvider('IInstruction');
    let viewFactoryProvider: ViewFactoryProvider;
    let locationProvider: InstanceProvider<IRenderLocation>;
    let slotInfoProvider: InstanceProvider<AuSlotsInfo>;

    controllerProvider.prepare(parentController);
    nodeProvider.prepare(host);
    instructionProvider.prepare(instruction);

    if (viewFactory == null) {
      viewFactoryProvider = noViewFactoryProvider;
    } else {
      viewFactoryProvider = new ViewFactoryProvider();
      viewFactoryProvider.prepare(viewFactory!);
    }
    if (location == null) {
      locationProvider = noLocationProvider;
    } else {
      locationProvider = new InstanceProvider('IRenderLocation');
      locationProvider.prepare(location);
    }
    if (auSlotsInfo == null) {
      slotInfoProvider = noAuSlotProvider;
    } else {
      slotInfoProvider = new InstanceProvider('AuSlotInfo');
      slotInfoProvider.prepare(auSlotsInfo);
    }

    container.registerResolver(INode, nodeProvider);
    container.registerResolver(p.Node, nodeProvider);
    container.registerResolver(p.Element, nodeProvider);
    container.registerResolver(p.HTMLElement, nodeProvider);
    container.registerResolver(IController, controllerProvider);
    container.registerResolver(IInstruction, instructionProvider);
    container.registerResolver(IRenderLocation, locationProvider);
    container.registerResolver(IViewFactory, viewFactoryProvider);
    container.registerResolver(IAuSlotsInfo, slotInfoProvider);

    return container;
  }

  public resourceInvoker: IContainer | null = null;
  public invokeAttribute(
    parentController: IController,
    host: HTMLElement,
    instruction: HydrateAttributeInstruction | HydrateTemplateController,
    viewFactory?: IViewFactory,
    location?: IRenderLocation,
    auSlotsInfo?: IAuSlotsInfo
  ): ICustomAttributeViewModel {
    const p = this.platform;
    const eProvider = this.elementProvider;
    const pcProvider = this.parentControllerProvider;
    const iProvider = this.instructionProvider;
    const fProvider = this.factoryProvider;
    const rlProvider = this.renderLocationProvider;
    const siProvider = this.auSlotsInfoProvider;
    const container = this.container;
    const definition = container.find(CustomAttribute, instruction.res);
    const Ctor = definition!.Type;
    let invoker = this.resourceInvoker;
    if (invoker == null) {
      invoker = container.createChild();
      invoker.registerResolver(INode, eProvider, true);
      invoker.registerResolver(p.Node, eProvider);
      invoker.registerResolver(p.Element, eProvider);
      invoker.registerResolver(p.HTMLElement, eProvider);
      invoker.registerResolver(IController, pcProvider, true);
      invoker.registerResolver(IInstruction, iProvider, true);
      invoker.registerResolver(IRenderLocation, rlProvider, true);
      invoker.registerResolver(IViewFactory, fProvider, true);
      invoker.registerResolver(IAuSlotsInfo, siProvider, true);
    }

    eProvider.prepare(host);
    pcProvider.prepare(parentController);
    iProvider.prepare(instruction);
    // null or undefined wouldn't matter
    // as it can just throw if trying to inject something non-existant
    fProvider.prepare(viewFactory!);
    rlProvider.prepare(location!);
    siProvider.prepare(auSlotsInfo!);

    const instance = invoker!.invoke(Ctor);
    invoker.dispose();

    return instance;
  }

  // public create

  // #region IComponentFactory api

  public render(
    flags: LifecycleFlags,
    controller: IHydratableController,
    targets: ArrayLike<INode>,
    definition: CustomElementDefinition,
    host: INode | null | undefined,
  ): void {
    if (targets.length !== definition.instructions.length) {
      throw new Error(`The compiled template is not aligned with the render instructions. There are ${targets.length} targets and ${definition.instructions.length} instructions.`);
    }

    for (let i = 0; i < targets.length; ++i) {
      this.renderChildren(
        /* flags        */flags,
        /* instructions */definition.instructions[i],
        /* controller   */controller,
        /* target       */targets[i],
      );
    }

    if (host !== void 0 && host !== null) {
      this.renderChildren(
        /* flags        */flags,
        /* instructions */definition.surrogates,
        /* controller   */controller,
        /* target       */host,
      );
    }
  }

  public renderChildren(
    flags: LifecycleFlags,
    instructions: readonly IInstruction[],
    controller: IHydratableController,
    target: unknown,
  ): void {
    for (let i = 0; i < instructions.length; ++i) {
      const current = instructions[i];
      this.renderers[current.type].render(flags, this, controller, target, current);
    }
  }

  public dispose(): void {
    throw new Error('Cannot dispose a render context');
  }
  // #endregion
}

class ViewFactoryProvider implements IResolver {
  private factory: IViewFactory | null = null;

  public prepare(factory: IViewFactory): void {
    this.factory = factory;
  }
  public get $isResolver(): true { return true; }

  public resolve(): IViewFactory {
    const factory = this.factory;
    if (factory === null) {
      throw new Error('Cannot resolve ViewFactory before the provider was prepared.');
    }
    if (typeof factory.name !== 'string' || factory.name.length === 0) {
      throw new Error('Cannot resolve ViewFactory without a (valid) name.');
    }
    return factory;
  }

  public dispose(): void {
    this.factory = null;
  }
}

const noLocationProvider = new InstanceProvider<IRenderLocation>('IRenderLocation');
const noViewFactoryProvider = new ViewFactoryProvider();
const noAuSlotProvider = new InstanceProvider<AuSlotsInfo>('AuSlotsInfo');
