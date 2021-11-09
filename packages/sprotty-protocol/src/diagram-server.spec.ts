/********************************************************************************
 * Copyright (c) 2021 TypeFox and others.
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

import 'mocha';
import { expect } from 'chai';
import { Action, ComputedBoundsAction, RequestBoundsAction, RequestModelAction, SetModelAction } from './actions';
import { DiagramServer } from './diagram-server';
import { BoundsAware, SModelRoot } from './model';

declare function setImmediate(callback: () => void): void;

async function condition(cb: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const next = () => {
            if (cb()) {
                resolve();
            } else if (attempts++ > 10) {
                reject();
            } else {
                setImmediate(next);
            }
        }
        next();
    });
}

describe('DiagramServer', () => {
    function createServer(): { server: DiagramServer, dispatched: Action[] } {
        const dispatched: Action[] = [];
        const server = new DiagramServer(
            async a => {
                dispatched.push(a)
            }, {
            diagramGenerator: {
                generate: () => {
                    return {
                        type: 'root',
                        id: 'root',
                    };
                }
            },
            layoutEngine: {
                layout: model => {
                    (model as SModelRoot & BoundsAware).position = { x: 10, y: 10 };
                    return model;
                }
            }
        });
        return { server, dispatched };
    }

    it('sets the model without client or server layout', async () => {
        const { server, dispatched } = createServer();
        await server.accept(<RequestModelAction>{
            kind: RequestModelAction.KIND,
            options: {
                needsClientLayout: false,
                needsServerLayout: false
            },
            requestId: 'req1'
        });
        expect(dispatched).to.have.lengthOf(1);
        expect(dispatched[0]).to.deep.equal({
            kind: SetModelAction.KIND,
            newRoot: {
                type: 'root',
                id: 'root',
                revision: 1
            },
            responseId: 'req1'
        });
    });

    it('sets the model with server layout, but without client layout', async () => {
        const { server, dispatched } = createServer();
        await server.accept(<RequestModelAction>{
            kind: RequestModelAction.KIND,
            options: {
                needsClientLayout: false,
                needsServerLayout: true
            },
            requestId: 'req1'
        });
        expect(dispatched).to.have.lengthOf(1);
        expect(dispatched[0]).to.deep.equal({
            kind: SetModelAction.KIND,
            newRoot: {
                type: 'root',
                id: 'root',
                revision: 1,
                position: { x: 10, y: 10 }
            },
            responseId: 'req1'
        });
    });

    it('requests bounds with client layout, but without server layout', async () => {
        const { server, dispatched } = createServer();
        await server.accept(<RequestModelAction>{
            kind: RequestModelAction.KIND,
            options: {
                needsClientLayout: true,
                needsServerLayout: false
            },
            requestId: 'req1'
        });
        expect(dispatched).to.have.lengthOf(1);
        expect(dispatched[0]).to.deep.equal({
            kind: RequestBoundsAction.KIND,
            newRoot: {
                type: 'root',
                id: 'root',
                revision: 1
            }
        });
    });

    it('requests bounds with client and server layout, then processes the bounds', async () => {
        const { server, dispatched } = createServer();
        server.accept(<RequestModelAction>{
            kind: RequestModelAction.KIND,
            options: {
                needsClientLayout: true,
                needsServerLayout: true
            },
            requestId: 'req1'
        });
        await condition(() => dispatched.length > 0);
        expect(dispatched).to.have.lengthOf(1);
        expect(dispatched[0].kind).to.equal(RequestBoundsAction.KIND);
        await server.accept(<ComputedBoundsAction>{
            kind: ComputedBoundsAction.KIND,
            bounds: [
                {
                    elementId: 'root',
                    newSize: { width: 100, height: 100 }
                }
            ],
            revision: (dispatched[0] as RequestBoundsAction).newRoot.revision,
            responseId: (dispatched[0] as RequestBoundsAction).requestId
        });
        await condition(() => dispatched.length > 1);
        expect(dispatched).to.have.lengthOf(2);
        expect(dispatched[1]).to.deep.equal({
            kind: SetModelAction.KIND,
            newRoot: {
                type: 'root',
                id: 'root',
                revision: 1,
                position: { x: 10, y: 10 },
                size: { width: 100, height: 100 }
            },
            responseId: 'req1'
        });
    });
});
