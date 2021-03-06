/**
 * @author Pedro Sanders
 * @since v1
 */
import RegisterHandler from 'core/processor/register_handler'
import CancelHandler from 'core/processor/cancel_handler'
import RouteInfo from 'core/processor/route_info'
import Context from 'core/context'
import AclUtil from 'core/acl/acl_util'
import getConfig from 'core/config_util'
import { Status } from 'location/status'
import { RoutingType } from 'core/routing_type'
import isEmpty from 'utils/obj_util'
import IPUtil from 'core/ip_util'

const SipFactory = Packages.javax.sip.SipFactory
const RouteHeader = Packages.javax.sip.header.RouteHeader
const ToHeader = Packages.javax.sip.header.ToHeader
const FromHeader = Packages.javax.sip.header.FromHeader
const ContactHeader = Packages.javax.sip.header.ContactHeader
const ViaHeader = Packages.javax.sip.header.ViaHeader
const MaxForwardsHeader = Packages.javax.sip.header.MaxForwardsHeader
const ProxyAuthorizationHeader = Packages.javax.sip.header.ProxyAuthorizationHeader
const Request = Packages.javax.sip.message.Request
const Response = Packages.javax.sip.message.Response
const HashMap = Packages.java.util.HashMap
const LogManager = Packages.org.apache.logging.log4j.LogManager
const LOG = LogManager.getLogger()

export default class RequestProcessor {

    constructor(sipProvider, locator, registry, registrar, dataAPIs, contextStorage) {
        this.sipProvider = sipProvider
        this.sipStack = this.sipProvider.getSipStack()
        this.contextStorage = contextStorage
        this.locator = locator
        this.registry = registry
        this.dataAPIs = dataAPIs
        this.domainsAPI = dataAPIs.DomainsAPI
        this.peersAPI = dataAPIs.PeersAPI
        this.agentsAPI = dataAPIs.AgentsAPI
        this.didsAPI = dataAPIs.DIDsAPI
        this.messageFactory = SipFactory.getInstance().createMessageFactory()
        this.headerFactory = SipFactory.getInstance().createHeaderFactory()
        this.addressFactory = SipFactory.getInstance().createAddressFactory()
        this.dsam = new Packages.gov.nist.javax.sip.clientauthutils.DigestServerAuthenticationHelper()
        this.config = getConfig()
        this.generalAcl = this.config.spec.accessControlList
        this.registerHandler = new RegisterHandler(locator, registrar)
        this.cancelHandler = new CancelHandler(sipProvider, contextStorage)
        this.ipUtil = new IPUtil()
    }

    process(event) {
        const requestIn = event.getRequest()
        const method = requestIn.getMethod()
        let serverTransaction = event.getServerTransaction()

        // ACK does not need a transaction
        if (serverTransaction == null && !method.equals(Request.ACK)) {
            serverTransaction = this.sipProvider.getNewServerTransaction(requestIn)
        }

        const requestOut = requestIn.clone()

        if (method.equals(Request.REGISTER)) {
            // Should we apply ACL rules here too?
            this.registerHandler.register(requestIn, serverTransaction)
            return
        } else if(method.equals(Request.CANCEL)) {
            this.cancelHandler.cancel(requestIn, serverTransaction)
            return
        } else {
            const fromHeader = requestIn.getHeader(FromHeader.NAME)
            const fromURI = fromHeader.getAddress().getURI()
            const remoteIp = event.getRemoteIpAddress()
            const routeInfo = new RouteInfo(requestIn, this.dataAPIs)

            LOG.debug('routing type -> ' + routeInfo.getRoutingType())

            // 1. Security check
            // This routing type is not yet supported
            if (routeInfo.getRoutingType().equals(RoutingType.INTER_DOMAIN_ROUTING)) {
                serverTransaction.sendResponse(this.messageFactory.createResponse(Response.FORBIDDEN, requestIn))
                LOG.debug(requestIn)
                return
            }

            if (!routeInfo.getRoutingType().equals(RoutingType.DOMAIN_INGRESS_ROUTING)) {
                // Do not need to authorized ACK messages...
                if (!method.equals(Request.ACK) && !method.equals(Request.BYE) && !this.authorized(requestIn, serverTransaction)) {
                    serverTransaction.sendResponse(this.messageFactory.createResponse(Response.UNAUTHORIZED, requestIn))
                    LOG.debug(requestIn)
                    return
                }
            } else {
                if (!this.registry.hasIp(remoteIp)) {
                    serverTransaction.sendResponse(this.messageFactory.createResponse(Response.UNAUTHORIZED, requestIn))
                    LOG.debug(requestIn)
                    return
                }
            }

            let addressOfRecord = this.getAOR(requestIn)

            // We only apply ACL rules to Domain Routing.
            if (routeInfo.getRoutingType().equals(RoutingType.INTRA_DOMAIN_ROUTING)) {
                const result = this.domainsAPI.getDomain(addressOfRecord.getHost())
                if (result.status == Status.OK) {
                    const domainObj = result.obj
                    if(!new AclUtil(this.generalAcl).isIpAllowed(domainObj, remoteIp)) {
                        serverTransaction.sendResponse(this.messageFactory.createResponse(Response.UNAUTHORIZED, requestIn))
                        LOG.debug(requestIn)
                        return
                    }
                }
            }

            // 2. Decrement the max forwards value
            const maxForwardsHeader = requestOut.getHeader(MaxForwardsHeader.NAME)
            maxForwardsHeader.decrementMaxForwards()

            // 3. Determine route
            // 3.0 Peer Egress Routing (PR)
            if (routeInfo.getRoutingType().equals(RoutingType.PEER_EGRESS_ROUTING)) {
                let telUrl

                // First look for the header 'DIDRef'
                if (requestOut.getHeader('DIDRef')) {
                    telUrl = this.addressFactory.createTelURL(requestOut.getHeader('DIDRef'))
                } else {
                    telUrl = this.addressFactory.createTelURL(fromURI.getUser())
                }

                let result = this.didsAPI.getDIDByTelUrl(telUrl)

                if (result.status == Status.NOT_FOUND) {
                    serverTransaction.sendResponse(this.messageFactory.createResponse(Response.TEMPORARILY_UNAVAILABLE, requestIn))
                    LOG.debug(requestIn)
                    return
                }

                const didRef = result.obj.metadata.ref
                result = this.locator.getEgressRouteForPeer(addressOfRecord, didRef)

                if (result.status == Status.NOT_FOUND) {
                    serverTransaction.sendResponse(this.messageFactory.createResponse(Response.TEMPORARILY_UNAVAILABLE, requestIn))
                    LOG.debug(requestIn)
                    return
                }

                this.processRoute(requestIn, requestOut, result.obj, serverTransaction)

                LOG.debug(requestOut)
                return
            }

            // 3.1 Intra-Domain Routing(IDR), Domain Ingress Routing (DIR), & Domain Egress Routing (DER)
            const result = this.locator.findEndpoint(addressOfRecord)

            if (result.status == Status.NOT_FOUND) {
                serverTransaction.sendResponse(this.messageFactory.createResponse(Response.TEMPORARILY_UNAVAILABLE, requestIn))
                LOG.debug(requestIn)
                return
            }

            // 4. Send response
            const location = result.obj

            if (location instanceof HashMap) {
                let caIterator

                try {
                    caIterator = location.values().iterator()
                } catch(e) {}

                if (!caIterator.hasNext()) {
                    serverTransaction.sendResponse(this.messageFactory.createResponse(Response.TEMPORARILY_UNAVAILABLE, requestIn))
                    LOG.debug(requestIn)
                    return
                }

                // Fork the call if needed
                while(caIterator.hasNext()) {
                    const route = caIterator.next()
                    this.processRoute(requestIn, requestOut, route, serverTransaction)
                }
            } else {
                const route = location
                this.processRoute(requestIn, requestOut, route, serverTransaction)
            }

            return
        }
        LOG.debug(requestIn)
    }

    processRoute(requestIn, requestOut, route, serverTransaction) {
        requestOut.setRequestURI(route.contactURI)
        const routeHeader = requestIn.getHeader(RouteHeader.NAME)
        const rVia = requestIn.getHeader(ViaHeader.NAME)
        const transport = rVia.getTransport().toLowerCase()
        const lp = this.sipProvider.getListeningPoint(transport)
        const localPort = lp.getPort()
        const localIp = lp.getIPAddress().toString()
        const method = requestIn.getMethod()
        const rcvHost = route.contactURI.getHost()

        LOG.debug('contactURI is -> ' + route.contactURI)
        LOG.debug('Behind nat -> ' + route.nat)
        LOG.debug('rcvHost is -> ' + rcvHost)
        LOG.debug('sentByAddress -> ' + route.sentByAddress)
        LOG.debug('sentByPort -> ' + route.sentByPort)
        LOG.debug('received -> ' + route.received)
        LOG.debug('rport -> ' + route.rport)

        let advertisedAddr
        let advertisedPort

        if (this.config.spec.externAddr && !this.ipUtil.isLocalnet(route.sentByAddress)) {
            advertisedAddr = this.config.spec.externAddr.contains(":") ? this.config.spec.externAddr.split(":")[0] : this.config.spec.externAddr
            advertisedPort = this.config.spec.externAddr.contains(":") ? this.config.spec.externAddr.split(":")[1] : lp.getPort()
        }  else {
            advertisedAddr = localIp
            advertisedPort = lp.getPort()
        }

        LOG.debug('advertisedAddr is -> ' + advertisedAddr)
        LOG.debug('advertisedPort is -> ' + advertisedPort)

        // Remove route header if host is same as the proxy
        if (routeHeader) {
            const routeHeaderHost = routeHeader.getAddress().getURI().getHost()
            const routeHeaderPort = routeHeader.getAddress().getURI().getPort()
            if ((routeHeaderHost.equals(localIp) && routeHeaderPort.equals(localPort))
                || ((routeHeaderHost.equals(advertisedAddr) && routeHeaderPort.equals(advertisedPort)))) {
                requestOut.removeFirst(RouteHeader.NAME)
            }
        }

        // Stay in the signaling path
        if (this.config.spec.recordRoute) {
            const proxyURI = this.addressFactory.createSipURI(null, advertisedAddr)
            proxyURI.setLrParam()
            proxyURI.setPort(advertisedPort)
            const proxyAddress = this.addressFactory.createAddress(proxyURI)
            const recordRouteHeader = this.headerFactory.createRecordRouteHeader(proxyAddress)
            requestOut.addHeader(recordRouteHeader)
        }

        // Request RPort to enable Symmetric Response in accordance with RFC 3581 and RFC 6314
        const viaHeader = this.headerFactory.createViaHeader(advertisedAddr, advertisedPort, transport, null)
        viaHeader.setRPort()
        requestOut.addFirst(viaHeader)

        if (route.thruGw) {
            const fromHeader = requestIn.getHeader(FromHeader.NAME)
            const toHeader = requestIn.getHeader(ToHeader.NAME)
            const gwRefHeader = this.headerFactory.createHeader('GwRef', route.gwRef)
            const remotePartyIdHeader = this.headerFactory
                .createHeader('Remote-Party-ID', '<sip:'+ route.did + '@' + route.gwHost+ '>;screen=yes;party=calling')

            const from = 'sip:' + route.gwUsername + '@' + route.gwHost
            const to = 'sip:' + toHeader.getAddress().toString().match('sips?:(.*)@(.*)')[1] + '@' + route.gwHost

            // This might not work with all provider
            const fromAddress = this.addressFactory.createAddress(from)
            const toAddress = this.addressFactory.createAddress(to)

            fromHeader.setAddress(fromAddress)
            toHeader.setAddress(toAddress)

            requestOut.setHeader(gwRefHeader)
            requestOut.setHeader(fromHeader)
            requestOut.setHeader(toHeader)
            requestOut.setHeader(remotePartyIdHeader)
        }

        // Warning: Not yet test :(
        requestOut.removeHeader("Proxy-Authorization")

        // Does not need a transaction
        if(method.equals(Request.ACK)) {
            this.sipProvider.sendRequest(requestOut)
        } else {
            try {
                // The request must be cloned or the stack will not fork the call
                const clientTransaction = this.sipProvider.getNewClientTransaction(requestOut.clone())
                clientTransaction.sendRequest()

                // Transaction context
                const context = new Context()
                context.clientTransaction = clientTransaction
                context.serverTransaction = serverTransaction
                context.method = method
                context.requestIn = requestIn
                context.requestOut = requestOut
                this.contextStorage.saveContext(context)
            } catch (e) {
                if (e instanceof java.net.ConnectException) {
                    LOG.error('Connection refused. Please see: https://docs.oracle.com/javase/7/docs/api/java/net/ConnectException.html')
                } else if (e instanceof java.net.NoRouteToHostException) {
                    LOG.error('No route to host. Please see: https://docs.oracle.com/javase/7/docs/api/java/net/NoRouteToHostException.html')
                } else {
                    LOG.error(e.getMessage())
                }
            }
        }

        LOG.debug(requestOut)
    }

    authorized(request, serverTransaction) {
        const authHeader = request.getHeader(ProxyAuthorizationHeader.NAME)
        const fromHeader = request.getHeader(FromHeader.NAME)
        const fromURI = fromHeader.getAddress().getURI()

        if (authHeader == null) {
            const challengeResponse = this.messageFactory.createResponse(Response.PROXY_AUTHENTICATION_REQUIRED, request)
            this.dsam.generateChallenge(this.headerFactory, challengeResponse, "sipio")
            serverTransaction.sendResponse(challengeResponse)
            LOG.debug(request)
            return
        }

        let result = this.peersAPI.getPeer(authHeader.getUsername())

        let user

        if (result.status == Status.OK) {
            user = result.obj
        } else {
            // This is also a security check. The user in the authentication must exist for the 'fromURI.getHost()' domain
            result = this.agentsAPI.getAgent(fromURI.getHost(), authHeader.getUsername())

            if (result.status == Status.OK ) {
                user = result.obj
            }
        }

        if (!this.dsam.doAuthenticatePlainTextPassword(request, user.spec.credentials.secret)) {
            const challengeResponse = this.messageFactory.createResponse(Response.PROXY_AUTHENTICATION_REQUIRED, request)
            this.dsam.generateChallenge(this.headerFactory, challengeResponse, "sipio")
            serverTransaction.sendResponse(challengeResponse)
            LOG.debug(request)
            return
        }

        return user != null
    }

    /**
     * Discover DIDs sent via a non-standard header
     * The header must be added at config.spec.addressInfo[*]
     * If the such header is present then overwrite the AOR
     */
    getAOR (request) {
        const toHeader = request.getHeader(ToHeader.NAME)

        if(!!this.config.spec.addressInfo) {
            this.config.spec.addressInfo.forEach(function(info) {
                if (!!request.getHeader(info)) {
                    return addressOfRecord = this.addressFactory.createTelURL(request.getHeader(info).getValue())
                }
            })
        }

        return toHeader.getAddress().getURI()
    }
}
