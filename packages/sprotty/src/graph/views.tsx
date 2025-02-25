/********************************************************************************
 * Copyright (c) 2017-2018 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

/** @jsx svg */
import { inject, injectable } from 'inversify';
import { VNode } from "snabbdom";
import { Point } from 'sprotty-protocol/lib/utils/geometry';
import { getSubType } from 'sprotty-protocol/lib/utils/model-utils';
import { IViewArgs, IView, RenderingContext } from "../base/views/view";
import { setAttr } from '../base/views/vnode-utils';
import { ShapeView } from '../features/bounds/views';
import { BY_X_THEN_Y, IntersectingRoutedPoint, Intersection, isIntersectingRoutedPoint } from '../features/edge-intersection/intersection-finder';
import { isEdgeLayoutable } from '../features/edge-layout/model';
import { SRoutableElement, SRoutingHandle } from '../features/routing/model';
import { EdgeRouterRegistry, RoutedPoint } from '../features/routing/routing';
import { RoutableView } from '../features/routing/views';
import { svg } from '../lib/jsx';
import { PointToPointLine } from '../utils/geometry';
import { SCompartment, SEdge, SGraph, SLabel } from "./sgraph";

/**
 * IView component that turns an SGraph element and its children into a tree of virtual DOM elements.
 */
@injectable()
export class SGraphView<IRenderingArgs> implements IView {

    @inject(EdgeRouterRegistry) edgeRouterRegistry: EdgeRouterRegistry;

    render(model: Readonly<SGraph>, context: RenderingContext, args?: IRenderingArgs): VNode {
        const edgeRouting = this.edgeRouterRegistry.routeAllChildren(model);
        const transform = `scale(${model.zoom}) translate(${-model.scroll.x},${-model.scroll.y})`;
        return <svg class-sprotty-graph={true}>
            <g transform={transform}>
                {context.renderChildren(model, { edgeRouting })}
            </g>
        </svg>;
    }

}

@injectable()
export class PolylineEdgeView extends RoutableView {

    @inject(EdgeRouterRegistry) edgeRouterRegistry: EdgeRouterRegistry;

    render(edge: Readonly<SEdge>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        const route = this.edgeRouterRegistry.route(edge, args);
        if (route.length === 0) {
            return this.renderDanglingEdge("Cannot compute route", edge, context);
        }
        if (!this.isVisible(edge, route, context)) {
            if (edge.children.length === 0) {
                return undefined;
            }
            // The children of an edge are not necessarily inside the bounding box of the route,
            // so we need to render a group to ensure the children have a chance to be rendered.
            return <g>{context.renderChildren(edge, { route })}</g>;
        }

        return <g class-sprotty-edge={true} class-mouseover={edge.hoverFeedback}>
            {this.renderLine(edge, route, context, args)}
            {this.renderAdditionals(edge, route, context)}
            {context.renderChildren(edge, { route })}
        </g>;
    }

    protected renderLine(edge: SEdge, segments: Point[], context: RenderingContext, args?: IViewArgs): VNode {
        const firstPoint = segments[0];
        let path = `M ${firstPoint.x},${firstPoint.y}`;
        for (let i = 1; i < segments.length; i++) {
            const p = segments[i];
            path += ` L ${p.x},${p.y}`;
        }
        return <path d={path} />;
    }

    protected renderAdditionals(edge: SEdge, segments: Point[], context: RenderingContext): VNode[] {
        // here we need to render the control points?
        return [];
    }

    protected renderDanglingEdge(message: string, edge: SEdge, context: RenderingContext): VNode {
        return <text class-sprotty-edge-dangling={true} title={message}>?</text>;
    }
}

/**
 * A `PolylineEdgeView` that renders jumps over intersections.
 *
 * In order to find intersections, `IntersectionFinder` needs to be configured as a `TYPES.IEdgeRoutePostprocessor`
 * so that that intersections are declared as `IntersectingRoutedPoint` in the computed routes.
 *
 * @see IntersectionFinder
 * @see IntersectingRoutedPoint
 * @see EdgeRouterRegistry
 */
@injectable()
export class JumpingPolylineEdgeView extends PolylineEdgeView {

    protected jumpOffsetBefore = 5;
    protected jumpOffsetAfter = 5;
    protected skipOffsetBefore = 3;
    protected skipOffsetAfter = 2;

    protected renderLine(edge: SEdge, segments: Point[], context: RenderingContext, args?: IViewArgs): VNode {
        let path = '';
        for (let i = 0; i < segments.length; i++) {
            const p = segments[i];
            if (i === 0) {
                path = `M ${p.x},${p.y}`;
            }
            if (isIntersectingRoutedPoint(p)) {
                path += this.intersectionPath(edge, segments, p, args);
            }
            if (i !== 0) {
                path += ` L ${p.x},${p.y}`;
            }
        }
        return <path d={path} />;
    }

    protected intersectionPath(edge: SEdge, segments: Point[], intersectingPoint: IntersectingRoutedPoint, args?: IViewArgs): string {
        let path = '';
        for (const intersection of intersectingPoint.intersections.sort(BY_X_THEN_Y)) {
            const otherLineSegment = this.getOtherLineSegment(edge, intersection, args);
            if (otherLineSegment === undefined) {
                continue;
            }
            const lineSegment = this.getLineSegment(edge, intersection, args, segments);
            const intersectionPoint = intersection.intersectionPoint;
            if (Math.abs(lineSegment.slopeOrMax) < Math.abs(otherLineSegment.slopeOrMax)) {
                path += this.createJumpPath(intersectionPoint, lineSegment);
            } else {
                path += this.createSkipPath(intersectionPoint, lineSegment);
            }
        }
        return path;
    }

    protected getOtherLineSegment(currentEdge: SEdge, intersection: Intersection, args?: IViewArgs): PointToPointLine | undefined {
        const otherEdgeId = intersection.routable1 === currentEdge.id ? intersection.routable2 : intersection.routable1;
        const otherEdge = currentEdge.index.getById(otherEdgeId);
        if (!(otherEdge instanceof SRoutableElement)) {
            return undefined;
        }
        return this.getLineSegment(otherEdge, intersection, args);
    }

    protected getLineSegment(edge: SRoutableElement, intersection: Intersection, args?: IViewArgs, segments?: Point[]): PointToPointLine {
        const route = segments ? segments : this.edgeRouterRegistry.route(edge, args);
        const index = intersection.routable1 === edge.id ? intersection.segmentIndex1 : intersection.segmentIndex2;
        return new PointToPointLine(route[index], route[index + 1]);
    }

    protected createJumpPath(intersectionPoint: Point, lineSegment: PointToPointLine): string {
        const anchorBefore = Point.shiftTowards(intersectionPoint, lineSegment.p1, this.jumpOffsetBefore);
        const anchorAfter = Point.shiftTowards(intersectionPoint, lineSegment.p2, this.jumpOffsetAfter);
        const rotation = lineSegment.p1.x < lineSegment.p2.x ? 1 : 0;
        return ` L ${anchorBefore.x},${anchorBefore.y} A 1,1 0,0 ${rotation} ${anchorAfter.x},${anchorAfter.y}`;
    }

    protected createSkipPath(intersectionPoint: Point, lineSegment: PointToPointLine): string {
        let offsetBefore;
        let offsetAfter;
        if (intersectionPoint.y < lineSegment.p1.y) {
            offsetBefore = -this.skipOffsetBefore;
            offsetAfter = this.jumpOffsetAfter + this.skipOffsetAfter;
        } else {
            offsetBefore = this.jumpOffsetBefore + this.skipOffsetAfter;
            offsetAfter = -this.skipOffsetBefore;
        }
        const anchorBefore = Point.shiftTowards(intersectionPoint, lineSegment.p1, offsetBefore);
        const anchorAfter = Point.shiftTowards(intersectionPoint, lineSegment.p2, offsetAfter);
        return ` L ${anchorBefore.x},${anchorBefore.y} M ${anchorAfter.x},${anchorAfter.y}`;
    }

}

/**
 * A `PolylineEdgeView` that renders gaps on intersections.
 *
 * In order to find intersections, `IntersectionFinder` needs to be configured as a `TYPES.IEdgeRoutePostprocessor`
 * so that that intersections are declared as `IntersectingRoutedPoint` in the computed routes.
 *
 * @see IntersectionFinder
 * @see IntersectingRoutedPoint
 * @see EdgeRouterRegistry
 */
 @injectable()
 export class PolylineEdgeViewWithGapsOnIntersections extends JumpingPolylineEdgeView {

    protected skipOffsetBefore = 3;
    protected skipOffsetAfter = 3;

    protected createJumpPath(intersectionPoint: Point, lineSegment: PointToPointLine): string {
        return "";
    }

    protected createSkipPath(intersectionPoint: Point, lineSegment: PointToPointLine): string {
        const anchorBefore = Point.shiftTowards(intersectionPoint, lineSegment.p1, this.skipOffsetBefore);
        const anchorAfter = Point.shiftTowards(intersectionPoint, lineSegment.p2, this.skipOffsetAfter);
        return ` L ${anchorBefore.x},${anchorBefore.y} M ${anchorAfter.x},${anchorAfter.y}`;
    }

 }

@injectable()
export class BezierCurveEdgeView extends RoutableView {

    @inject(EdgeRouterRegistry) edgeRouterRegistry: EdgeRouterRegistry;

    render(edge: Readonly<SEdge>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        const route = this.edgeRouterRegistry.route(edge, args);
        if (route.length === 0) {
            return this.renderDanglingEdge("Cannot compute route", edge, context);
        }
        if (!this.isVisible(edge, route, context)) {
            if (edge.children.length === 0) {
                return undefined;
            }
            // The children of an edge are not necessarily inside the bounding box of the route,
            // so we need to render a group to ensure the children have a chance to be rendered.
            return <g>{context.renderChildren(edge, { route })}</g>;
        }

        return <g class-sprotty-edge={true} class-mouseover={edge.hoverFeedback}>
            {this.renderLine(edge, route, context, args)}
            {this.renderAdditionals(edge, route, context)}
            {context.renderChildren(edge, { route })}
        </g>;
    }

    protected renderLine(edge: SEdge, segments: Point[], context: RenderingContext, args?: IViewArgs): VNode {
        /**
         * Example for two splines:
         * SVG:
         * <path d="M0,300 C0,150 300,150 300,300 S600,450 600,300" />
         *
         * Segments input layout:
         * routingPoints[0] = source;
         * routingPoints[1] = controlForSource;
         * routingPoints[2] = controlForSegment1;
         * routingPoints[3] = segment;
         * routingPoints[4] = controlForSegment2;
         * routingPoints[5] = controlForTarget;
         * routingPoints[6] = target;
         */
        let path = '';
        if (segments.length >= 4) {
            path += this.buildMainSegment(segments);
            const pointsLeft = segments.length - 4;
            if (pointsLeft > 0 && pointsLeft % 3 === 0) {
                for (let i = 4; i < segments.length; i += 3) {
                    path += this.addSpline(segments, i);
                }
            }
        }
        return <path d={path} />;
    }

    private buildMainSegment(segments: Point[]) {
        const s = segments[0];
        const h1 = segments[1];
        const h2 = segments[2];
        const t = segments[3];
        return `M${s.x},${s.y} C${h1.x},${h1.y} ${h2.x},${h2.y} ${t.x},${t.y}`;
    }

    private addSpline(segments: Point[], index: number) {
        // We have two controls for each junction, but SVG does not therefore index is jumped over
        const c = segments[index + 1];
        const p = segments[index + 2];
        return ` S${c.x},${c.y} ${p.x},${p.y}`;
    }

    protected renderAdditionals(edge: SEdge, segments: Point[], context: RenderingContext): VNode[] {
        return [];
    }

    protected renderDanglingEdge(message: string, edge: SEdge, context: RenderingContext): VNode {
        return <text class-sprotty-edge-dangling={true} title={message}>?</text>;
    }
}

@injectable()
export class SRoutingHandleView implements IView {

    @inject(EdgeRouterRegistry) edgeRouterRegistry: EdgeRouterRegistry;

    minimalPointDistance: number = 10;

    render(handle: Readonly<SRoutingHandle>, context: RenderingContext, args?: { route?: RoutedPoint[] }): VNode {
        if (args && args.route) {
            if (handle.parent instanceof SRoutableElement) {
                const router = this.edgeRouterRegistry.get(handle.parent.routerKind);
                const theRoute = args.route === undefined ? this.edgeRouterRegistry.route(handle.parent, args) : args.route;
                const position = router.getHandlePosition(handle.parent, theRoute, handle);
                if (position !== undefined) {
                    const node = <circle class-sprotty-routing-handle={true}
                        class-selected={handle.selected} class-mouseover={handle.hoverFeedback}
                        cx={position.x} cy={position.y} r={this.getRadius()} />;
                    setAttr(node, 'data-kind', handle.kind);
                    return node;
                }
            }
        }
        // Fallback: Create an empty group
        return <g />;
    }

    getRadius(): number {
        return 7;
    }
}

@injectable()
export class SLabelView extends ShapeView {
    render(label: Readonly<SLabel>, context: RenderingContext): VNode | undefined {
        if (!isEdgeLayoutable(label) && !this.isVisible(label, context)) {
            return undefined;
        }
        const vnode = <text class-sprotty-label={true}>{label.text}</text>;
        const subType = getSubType(label);
        if (subType) {
            setAttr(vnode, 'class', subType);
        }
        return vnode;
    }
}

@injectable()
export class SCompartmentView implements IView {
    render(compartment: Readonly<SCompartment>, context: RenderingContext, args?: IViewArgs): VNode | undefined {
        const translate = `translate(${compartment.bounds.x}, ${compartment.bounds.y})`;
        const vnode = <g transform={translate} class-sprotty-comp="{true}">
            {context.renderChildren(compartment)}
        </g>;
        const subType = getSubType(compartment);
        if (subType)
            setAttr(vnode, 'class', subType);
        return vnode;
    }
}

@injectable()
export class SBezierCreateHandleView extends SRoutingHandleView {

    render(handle: Readonly<SRoutingHandle>, context: RenderingContext, args?: { route?: RoutedPoint[] }): VNode {
        if (args) {
            const theRoute = args.route;
            if (theRoute && handle.parent instanceof SRoutableElement) {
                const router = this.edgeRouterRegistry.get(handle.parent.routerKind);
                const position = router.getHandlePosition(handle.parent, theRoute, handle);
                if (position !== undefined) {

                    const translation = "translate(" + position.x + ", " + position.y + ")";
                    const textOffsetX = -5.5;
                    const textOffsetY = 5.5;
                    const text = (handle.kind === "bezier-add") ? "+" : "-";
                    const node =
                        <g transform={translation} class-sprotty-routing-handle={true}
                                class-selected={handle.selected} class-mouseover={handle.hoverFeedback}>
                            <circle r={this.getRadius()} />
                            <text x={textOffsetX} y={textOffsetY} attrs-text-align="middle"
                                style-font-family="monospace" style-pointer-events="none" style-fill="white">{text}</text>
                        </g>;
                    setAttr(node, 'data-kind', handle.kind);
                    return node;
                }
            }
        }
        // Fallback: Create an empty group
        return <g />;
    }
}

@injectable()
export class SBezierControlHandleView extends SRoutingHandleView {

    render(handle: Readonly<SRoutingHandle>, context: RenderingContext, args?: { route?: RoutedPoint[] }): VNode {
        if (args) {
            const theRoute = args.route;
            if (theRoute && handle.parent instanceof SRoutableElement) {
                const router = this.edgeRouterRegistry.get(handle.parent.routerKind);
                const position = router.getHandlePosition(handle.parent, theRoute, handle) as any;
                if (position !== undefined) {

                    let pathEndPos: Point | undefined;
                    for (let i = 0; i < theRoute.length; i++) {
                        const elem = theRoute[i];
                        if (elem.kind === position.kind && elem.pointIndex === position.pointIndex) {
                            if (handle.kind === 'bezier-control-before') {
                                pathEndPos = theRoute[i + 1];
                            } else {
                                pathEndPos = theRoute[i - 1];
                            }
                            break;
                        }
                    }

                    let node;
                    if (pathEndPos) {
                        const coords = `M ${position.x}, ${position.y} L ${pathEndPos.x}, ${pathEndPos.y}`;
                        node =
                            <g class-sprotty-routing-handle={true} class-selected={handle.selected} class-mouseover={handle.hoverFeedback}>
                                <path d={coords} stroke="grey" style-stroke-width="2px"></path>
                                <circle cx={position.x} cy={position.y} r={this.getRadius()} />
                            </g>;
                    } else {
                        node = <circle class-sprotty-routing-handle={true} class-selected={handle.selected} class-mouseover={handle.hoverFeedback}
                                cx={position.x} cy={position.y} r={this.getRadius()} />;
                    }

                    setAttr(node, 'data-kind', handle.kind);
                    return node;
                }
            }
        }
        // Fallback: Create an empty group
        return <g />;
    }
}
